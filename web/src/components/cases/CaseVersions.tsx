import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../api/client.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { reportLang, type RLang } from '../report/reportText.ts';
import './CaseVersions.css';

/** 案例版本(後端 infra/lambda/api/cases.ts CaseVersion;清單不含 yaml)。 */
export interface CaseVersionSummary {
  version: string;
  app: string;
  caseId: string;
  name: string;
  createdAt: string;
  createdBy?: string;
  sha256: string;
  source: 'create' | 'edit' | 'baseline';
  basedOn?: string;
  yaml?: string;
}

const T = {
  title: ['版本紀錄', 'Version history'],
  hint: [
    '每次儲存都會產生一個不可修改的版本號(台北時間 YYYY-MMDD-HHmm-SSss)。切換版本只會改變「目前使用中」的內容,不會改動或刪除任何版本;測試報告會記錄執行時使用的版本。',
    'Every save creates an immutable version id (Taipei time YYYY-MMDD-HHmm-SSss). Switching only changes which version is in use; no version is ever modified or deleted. Reports record the version they ran with.',
  ],
  active: ['使用中', 'In use'],
  preview: ['預覽', 'Preview'],
  hide: ['收合', 'Hide'],
  activate: ['切換為使用中', 'Use this version'],
  activating: ['切換中…', 'Switching…'],
  confirm: ['切換到版本 {v}?編輯器中未儲存的修改會被取代。', 'Switch to version {v}? Unsaved edits in the editor will be replaced.'],
  basedOn: ['基於', 'based on'],
  create: ['建立', 'Created'],
  edit: ['編輯', 'Edited'],
  baseline: ['基準(既有內容)', 'Baseline (existing)'],
  empty: ['尚無版本。', 'No versions yet.'],
  loadError: ['無法載入版本紀錄。', 'Could not load versions.'],
  current: ['目前版本', 'Current version'],
  copy: ['複製版本號', 'Copy version id'],
  copied: ['已複製', 'Copied'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];

/** 版本號徽章(等寬字,可點擊複製)。 */
export function CaseVersionBadge({ version, title }: { version?: string; title?: string }) {
  const { locale } = useI18n();
  const lang = reportLang(locale);
  const [copied, setCopied] = useState(false);
  if (!version) return null;
  return (
    <button
      type="button"
      className="cver__badge"
      title={title ?? tx('copy', lang)}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(version).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
      }}
    >
      <span className="cver__badge-v" aria-hidden="true">v</span>
      {version}
      {copied && <span className="cver__badge-ok">{tx('copied', lang)}</span>}
    </button>
  );
}

/**
 * 案例版本紀錄面板(編輯表單內):列出所有不可變版本,可預覽內容、一鍵切換使用中的版本。
 * reloadKey 變動(例如剛儲存)時重新載入。
 */
export function CaseVersions({
  app,
  caseId,
  reloadKey,
  onActivated,
}: {
  app: string;
  caseId: string;
  reloadKey?: unknown;
  /** 切換成功後回傳該版本的名稱/YAML,讓編輯器同步。 */
  onActivated?: (v: { version: string; name: string; yaml: string }) => void;
}) {
  const { locale } = useI18n();
  const lang = reportLang(locale);
  const [items, setItems] = useState<CaseVersionSummary[]>([]);
  const [active, setActive] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [yamlCache, setYamlCache] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/cases/${encodeURIComponent(app)}/${encodeURIComponent(caseId)}/versions`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await apiGet<{ active?: string; items: CaseVersionSummary[] }>(base);
      setItems(res.items);
      setActive(res.active);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { void load(); }, [load, reloadKey]);

  const fetchYaml = async (v: string): Promise<string | null> => {
    if (yamlCache[v] !== undefined) return yamlCache[v]!;
    try {
      const rec = await apiGet<CaseVersionSummary>(`${base}/${encodeURIComponent(v)}`);
      const y = rec.yaml ?? '';
      setYamlCache((c) => ({ ...c, [v]: y }));
      return y;
    } catch {
      return null;
    }
  };

  const togglePreview = async (v: string) => {
    if (open === v) { setOpen(null); return; }
    await fetchYaml(v);
    setOpen(v);
  };

  const activate = async (v: CaseVersionSummary) => {
    if (!window.confirm(tx('confirm', lang).replace('{v}', v.version))) return;
    setBusy(v.version);
    try {
      const res = await apiPost<{ name: string; yaml: string; version: string }>(`${base}/${encodeURIComponent(v.version)}/activate`, {});
      setActive(res.version);
      onActivated?.(res);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  };

  const sourceText = (s: CaseVersionSummary['source']) => tx(s === 'create' ? 'create' : s === 'baseline' ? 'baseline' : 'edit', lang);
  const time = (iso: string) => new Date(iso).toLocaleString(locale);

  return (
    <section className="cver" aria-label={tx('title', lang)}>
      <header className="cver__head">
        <h3 className="cver__title">{tx('title', lang)} <span className="cver__count">{items.length}</span></h3>
        {active && <span className="cver__current">{tx('current', lang)} <CaseVersionBadge version={active} /></span>}
      </header>
      <p className="cver__hint">{tx('hint', lang)}</p>
      {loading && items.length === 0 ? (
        <p className="cver__muted">…</p>
      ) : error ? (
        <p className="cver__error" role="alert">{tx('loadError', lang)}</p>
      ) : items.length === 0 ? (
        <p className="cver__muted">{tx('empty', lang)}</p>
      ) : (
        <ol className="cver__list">
          {items.map((v) => {
            const isActive = v.version === active;
            return (
              <li key={v.version} className={`cver__item ${isActive ? 'is-active' : ''}`}>
                <div className="cver__row">
                  <span className="cver__v">{v.version}</span>
                  {isActive && <span className="cver__active">{tx('active', lang)}</span>}
                  <span className="cver__meta">
                    {sourceText(v.source)} · {time(v.createdAt)}
                    {v.createdBy ? ` · ${v.createdBy}` : ''}
                    {v.basedOn ? ` · ${tx('basedOn', lang)} ${v.basedOn}` : ''}
                  </span>
                  <span className="cver__name" title={v.name}>{v.name}</span>
                  <span className="cver__sha" title={`sha256 ${v.sha256}`}>#{v.sha256.slice(0, 8)}</span>
                  <span className="cver__actions">
                    <button type="button" className="cver__btn" aria-expanded={open === v.version} onClick={() => void togglePreview(v.version)}>
                      {open === v.version ? tx('hide', lang) : tx('preview', lang)}
                    </button>
                    {!isActive && (
                      <button type="button" className="cver__btn cver__btn--primary" disabled={busy !== null} onClick={() => void activate(v)}>
                        {busy === v.version ? tx('activating', lang) : tx('activate', lang)}
                      </button>
                    )}
                  </span>
                </div>
                {open === v.version && (
                  <pre className="cver__yaml">{yamlCache[v.version] ?? ''}</pre>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
