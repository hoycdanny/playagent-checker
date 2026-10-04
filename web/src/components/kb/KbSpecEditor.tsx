import type { ExcludeKey, L10n, ReportSpecInput, TemplateDescriptor } from './kbTypes.ts';
import { SCOPES } from './kbTypes.ts';
import { kt, tr } from './kbText.ts';
import { SCOPE_TEXT } from '../report/reportText.ts';
import type { RLang } from '../report/reportText.ts';
import './KbSpecEditor.css';

/**
 * 報告規格編輯器:樣板(類型 + 通用)的預設配置一覽,加上「覆寫 / 新增 / 停用」。
 * onChange 未提供 = 唯讀(檢視內建樣板)。
 */
export function KbSpecEditor({
  spec,
  onChange,
  genreTemplate,
  globalTemplate,
  lang,
}: {
  spec: ReportSpecInput;
  onChange?: (next: ReportSpecInput) => void;
  genreTemplate?: TemplateDescriptor;
  globalTemplate?: TemplateDescriptor;
  lang: RLang;
}) {
  const ro = !onChange;
  const set = (patch: Partial<ReportSpecInput>) => onChange?.(clean({ ...spec, ...patch }));
  const thresholds = (genreTemplate ?? globalTemplate)?.thresholds ?? [];
  const excluded = (k: ExcludeKey) => new Set(spec.exclude?.[k] ?? []);
  const toggle = (k: ExcludeKey, id: string, enabled: boolean) => {
    const cur = new Set(spec.exclude?.[k] ?? []);
    if (enabled) cur.delete(id);
    else cur.add(id);
    set({ exclude: { ...(spec.exclude ?? {}), [k]: [...cur] } });
  };

  return (
    <div className="kbs">
      <p className="kbs__intro">{kt('specIntro', lang)}</p>
      {!genreTemplate && <p className="kbs__note">{kt('noGenreForSpec', lang)}</p>}

      {/* 規格值 */}
      {genreTemplate && genreTemplate.specValues.length > 0 && (
        <section className="kbs__sec">
          <h4>{kt('specValues', lang)}</h4>
          <p className="kbs__hint">{kt('specValuesHint', lang)}</p>
          <div className="kbs__grid">
            {genreTemplate.specValues.map((v) => (
              <label key={v.key} className="kbs__field">
                <span>{tr(v.label, lang)}{v.unit ? ` (${v.unit})` : ''}</span>
                <input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={spec.values?.[v.key] ?? ''}
                  placeholder="—"
                  disabled={ro}
                  onChange={(e) => set({ values: numPatch(spec.values, v.key, e.target.value) })}
                />
                <small>{tr(v.hint, lang)}</small>
              </label>
            ))}
          </div>
        </section>
      )}

      {/* 門檻 */}
      {thresholds.length > 0 && (
        <section className="kbs__sec">
          <h4>{kt('thresholds', lang)}</h4>
          <p className="kbs__hint">{kt('thresholdsHint', lang)}</p>
          <table className="kbs__table">
            <thead>
              <tr>
                <th scope="col">{kt('thresholds', lang)}</th>
                <th scope="col">{kt('defaultLabel', lang)}</th>
                <th scope="col">{kt('yourValue', lang)}</th>
              </tr>
            </thead>
            <tbody>
              {thresholds.map((th) => {
                const v = spec.thresholds?.[th.key];
                return (
                  <tr key={th.key} className={v !== undefined ? 'is-overridden' : ''}>
                    <th scope="row">{tr(th.label, lang)} <code>{th.key}</code></th>
                    <td>{th.default}{unit(th.unit)}</td>
                    <td>
                      <input
                        type="number"
                        step="any"
                        aria-label={tr(th.label, lang)}
                        value={v ?? ''}
                        placeholder={String(th.default)}
                        disabled={ro}
                        onChange={(e) => set({ thresholds: numPatch(spec.thresholds, th.key, e.target.value) })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* 繼承項目(可停用) */}
      <section className="kbs__sec">
        <h4>{kt('inherited', lang)}</h4>
        {genreTemplate && (
          <Inherited title={`${kt('inheritedGenre', lang)}:${tr(genreTemplate.label, lang)} v${genreTemplate.version}`} t={genreTemplate} lang={lang} ro={ro} excluded={excluded} toggle={toggle} />
        )}
        {globalTemplate && (
          <Inherited title={kt('inheritedGlobal', lang)} t={globalTemplate} lang={lang} ro={ro} excluded={excluded} toggle={toggle} />
        )}
      </section>

      {/* 自訂觀測欄位 */}
      {(!ro || (spec.observe?.length ?? 0) > 0) && (
        <section className="kbs__sec">
          <h4>{kt('customObserve', lang)}</h4>
          <p className="kbs__hint">{kt('customObserveHint', lang)}</p>
          {(spec.observe ?? []).map((o, i) => (
            <div key={i} className="kbs__row">
              <input aria-label={kt('key', lang)} placeholder={kt('key', lang)} value={o.key} disabled={ro} onChange={(e) => set({ observe: replaceAt(spec.observe, i, { ...o, key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') }) })} />
              <input aria-label={kt('zhLabel', lang)} placeholder={kt('zhLabel', lang)} value={o.zh} disabled={ro} onChange={(e) => set({ observe: replaceAt(spec.observe, i, { ...o, zh: e.target.value }) })} />
              <input aria-label={kt('hint', lang)} placeholder={kt('hint', lang)} value={o.hint ?? ''} disabled={ro} onChange={(e) => set({ observe: replaceAt(spec.observe, i, { ...o, hint: e.target.value }) })} className="kbs__wide" />
              <select aria-label={kt('type', lang)} value={o.type ?? 'number'} disabled={ro} onChange={(e) => set({ observe: replaceAt(spec.observe, i, { ...o, type: e.target.value as 'number' }) })}>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="string">string</option>
              </select>
              {!ro && <button type="button" className="kbs__remove" onClick={() => set({ observe: (spec.observe ?? []).filter((_, j) => j !== i) })}>{kt('remove', lang)}</button>}
            </div>
          ))}
          {!ro && (
            <button type="button" className="kbs__add" onClick={() => set({ observe: [...(spec.observe ?? []), { key: '', zh: '', type: 'number' }] })}>
              + {kt('add', lang)}
            </button>
          )}
        </section>
      )}

      {/* 自訂模組 */}
      {(!ro || (spec.modules?.length ?? 0) > 0) && (
        <section className="kbs__sec">
          <h4>{kt('customModules', lang)}</h4>
          <p className="kbs__hint">{kt('customModulesHint', lang)}</p>
          {(spec.modules ?? []).map((m, i) => (
            <div key={i} className="kbs__row">
              <input aria-label={kt('key', lang)} placeholder={kt('key', lang)} value={m.id} disabled={ro} onChange={(e) => set({ modules: replaceAt(spec.modules, i, { ...m, id: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') }) })} />
              <input aria-label={kt('zhLabel', lang)} placeholder={kt('zhLabel', lang)} value={m.zh} disabled={ro} onChange={(e) => set({ modules: replaceAt(spec.modules, i, { ...m, zh: e.target.value }) })} />
              <input aria-label={kt('keywords', lang)} placeholder={kt('keywords', lang)} value={(m.keywords ?? []).join(', ')} disabled={ro} className="kbs__wide"
                onChange={(e) => set({ modules: replaceAt(spec.modules, i, { ...m, keywords: e.target.value.split(/[,，、]/).map((k) => k.trim()).filter(Boolean) }) })} />
              <label className="kbs__inline"><input type="checkbox" checked={Boolean(m.core)} disabled={ro} onChange={(e) => set({ modules: replaceAt(spec.modules, i, { ...m, core: e.target.checked }) })} /> {kt('core', lang)}</label>
              {!ro && <button type="button" className="kbs__remove" onClick={() => set({ modules: (spec.modules ?? []).filter((_, j) => j !== i) })}>{kt('remove', lang)}</button>}
            </div>
          ))}
          {!ro && (
            <button type="button" className="kbs__add" onClick={() => set({ modules: [...(spec.modules ?? []), { id: '', zh: '', keywords: [] }] })}>
              + {kt('add', lang)}
            </button>
          )}
        </section>
      )}

      {/* 測試範疇 */}
      <section className="kbs__sec">
        <h4>{kt('extraScopes', lang)}</h4>
        <div className="kbs__chips">
          {SCOPES.map((s) => {
            const inherited = (genreTemplate?.scopes ?? []).includes(s) || (globalTemplate?.scopes ?? []).includes(s);
            const on = inherited || (spec.scopes ?? []).includes(s);
            return (
              <label key={s} className={`kbs__chip ${on ? 'is-on' : ''} ${inherited ? 'is-inherited' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={ro || inherited}
                  onChange={(e) => set({ scopes: e.target.checked ? [...(spec.scopes ?? []), s] : (spec.scopes ?? []).filter((x) => x !== s) })}
                />
                {tr(SCOPE_TEXT[s] as L10n, lang) || s}
              </label>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Inherited({
  title,
  t,
  lang,
  ro,
  excluded,
  toggle,
}: {
  title: string;
  t: TemplateDescriptor;
  lang: RLang;
  ro: boolean;
  excluded: (k: ExcludeKey) => Set<string>;
  toggle: (k: ExcludeKey, id: string, enabled: boolean) => void;
}) {
  const groups: Array<{ k: ExcludeKey; label: string; items: Array<{ id: string; label: string; detail?: string }> }> = [
    { k: 'modules', label: kt('modules', lang), items: t.modules.map((m) => ({ id: m.id, label: tr(m.label, lang), detail: m.core ? kt('core', lang) : '' })) },
    { k: 'mechanics', label: kt('mechanics', lang), items: t.mechanics.map((m) => ({ id: m.id, label: tr(m.label, lang) })) },
    { k: 'observe', label: kt('observe', lang), items: t.observe.map((o) => ({ id: o.key, label: tr(o.label, lang), detail: o.hint })) },
    { k: 'metrics', label: kt('metrics', lang), items: t.metrics.map((m) => ({ id: m.id, label: tr(m.label, lang), detail: m.unit })) },
    { k: 'charts', label: kt('charts', lang), items: t.charts.map((c) => ({ id: c.id, label: tr(c.title, lang) })) },
    {
      k: 'riskRules',
      label: kt('riskRules', lang),
      items: t.riskRules.map((r) => ({ id: r.id, label: tr(r.title, lang), detail: `${r.level} · ${r.metric} ${r.op} ${r.thresholdKey ?? r.value}` })),
    },
    {
      k: 'releaseRules',
      label: kt('releaseRules', lang),
      items: t.releaseRules.map((r) => ({ id: r.id, label: tr(r.reason, lang), detail: `${r.outcome} · ${r.metric} ${r.op} ${r.thresholdKey ?? r.value}` })),
    },
  ].filter((g) => g.items.length > 0) as Array<{ k: ExcludeKey; label: string; items: Array<{ id: string; label: string; detail?: string }> }>;

  return (
    <div className="kbs__inherited">
      <h5>{title}</h5>
      {groups.map((g) => {
        const ex = excluded(g.k);
        const disabledHere = g.items.filter((i) => ex.has(i.id)).length;
        return (
          <details key={g.k} className="kbs__group">
            <summary>
              {g.label} <span className="kbs__count">{g.items.length - disabledHere}/{g.items.length}</span>
              {disabledHere > 0 && <span className="kbs__off">{kt('disabledCount', lang, { n: disabledHere })}</span>}
            </summary>
            <ul>
              {g.items.map((i) => (
                <li key={i.id} className={ex.has(i.id) ? 'is-off' : ''}>
                  <label>
                    <input type="checkbox" checked={!ex.has(i.id)} disabled={ro} onChange={(e) => toggle(g.k, i.id, e.target.checked)} />
                    <span>{i.label}</span>
                    {i.detail && <small>{i.detail}</small>}
                  </label>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}

function unit(u: string): string {
  return u && u !== 'count' ? ` ${u}` : '';
}

function numPatch(map: Record<string, number> | undefined, key: string, raw: string): Record<string, number> {
  const next = { ...(map ?? {}) };
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) delete next[key];
  else next[key] = n;
  return next;
}

function replaceAt<T>(list: T[] | undefined, i: number, v: T): T[] {
  const next = [...(list ?? [])];
  next[i] = v;
  return next;
}

/** 移除空集合,讓儲存的規格保持精簡。 */
function clean(s: ReportSpecInput): ReportSpecInput {
  const out: ReportSpecInput = {};
  if (s.values && Object.keys(s.values).length) out.values = s.values;
  if (s.thresholds && Object.keys(s.thresholds).length) out.thresholds = s.thresholds;
  if (s.modules?.length) out.modules = s.modules;
  if (s.observe?.length) out.observe = s.observe;
  if (s.scopes?.length) out.scopes = [...new Set(s.scopes)];
  if (s.exclude) {
    const ex = Object.fromEntries(Object.entries(s.exclude).filter(([, v]) => v && v.length));
    if (Object.keys(ex).length) out.exclude = ex;
  }
  return out;
}
