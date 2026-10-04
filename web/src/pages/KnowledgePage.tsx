import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  uploadToS3,
  type ListResponse,
} from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import GenreIcon, { GENRES, genreLabelKey, type Genre } from '../components/GenreIcon.tsx';
import IconSelect, { type IconSelectOption } from '../components/IconSelect.tsx';
import { KbSpecEditor } from '../components/kb/KbSpecEditor.tsx';
import { kbLang, kt, tr } from '../components/kb/kbText.ts';
import type { KbKind, KbListResponse, KbUsage, KnowledgeBase, ReportSpecInput } from '../components/kb/kbTypes.ts';
import './ListPage.css';
import './KnowledgePage.css';

/**
 * 知識庫管理:
 *  - 類型樣板(內建、唯讀):每種遊戲類型的預設配置(Agent 知識 + 模組/觀測/指標/規則/門檻/規格值)。
 *  - 我的知識庫:從樣板「複製並客製化」,覆寫門檻、填規格值、新增觀測/模組、停用不適用的規則。
 *  - 刪除防呆:仍被 App 預設或測試任務引用的知識庫不能刪,只能封存(既有設定/報告不受影響)。
 */

interface KbDoc {
  key: string;
  name: string;
  size?: number;
}

interface IngestionStatus {
  status: string | null;
  documentsAdded?: number;
  documentsFailed?: number;
  failureReasons?: string[];
}

type Tab = 'templates' | 'mine';
type EditorMode = 'create' | 'edit' | 'view';

interface FormState {
  mode: EditorMode;
  id: string | null;
  name: string;
  description: string;
  kind: KbKind;
  genre: '' | Genre;
  markdown: string;
  reportSpec: ReportSpecInput;
  enableRetrieval: boolean;
}

const EMPTY_FORM: FormState = {
  mode: 'create',
  id: null,
  name: '',
  description: '',
  kind: 'category',
  genre: '',
  markdown: '',
  reportSpec: {},
  enableRetrieval: false,
};

function genreOptions(t: (k: MessageKey) => string): IconSelectOption[] {
  return GENRES.map((g) => ({ value: g, label: t(genreLabelKey(g)), icon: <GenreIcon genre={g} size={16} /> }));
}

export default function KnowledgePage() {
  const { t, locale } = useI18n();
  const lang = kbLang(locale);
  const { data, loading, error, refetch } = useQuery<KbListResponse>('knowledge-bases', () =>
    apiGet<KbListResponse>('/knowledge-bases'),
  );
  const items = data?.items ?? [];
  const globalTemplate = data?.globalTemplate;
  const templates = items.filter((k) => k.builtin);
  const mine = items.filter((k) => !k.builtin);

  const [tab, setTab] = useState<Tab>('templates');
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inUse, setInUse] = useState<{ kb: KnowledgeBase; usage: KbUsage } | null>(null);

  // 首次載入:已有自己的知識庫就預設顯示「我的知識庫」。
  const tabInit = useRef(false);
  useEffect(() => {
    if (!tabInit.current && data) {
      tabInit.current = true;
      if (mine.length > 0) setTab('mine');
    }
  }, [data, mine.length]);

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (form) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [form?.id, form?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const needle = q.trim().toLowerCase();
  const match = (k: KnowledgeBase) =>
    !needle ||
    [k.name, k.description, k.genre ? t(genreLabelKey(k.genre)) : '', k.clonedFrom?.name].filter(Boolean).join(' ').toLowerCase().includes(needle);
  const shownTemplates = templates.filter(match).sort((a, b) => a.name.localeCompare(b.name));
  const shownMine = mine.filter((k) => (showArchived || !k.archived) && match(k));

  const templateFor = (genre: string | undefined) =>
    genre ? templates.find((k) => k.genre === genre)?.reportProfile : undefined;

  function openCreate() {
    setForm({ ...EMPTY_FORM });
  }
  function openKb(kb: KnowledgeBase) {
    setForm({
      mode: kb.builtin ? 'view' : 'edit',
      id: kb.id,
      name: kb.name,
      description: kb.description ?? '',
      kind: kb.kind,
      genre: kb.genre ?? '',
      markdown: kb.markdown ?? '',
      reportSpec: kb.reportSpec ?? {},
      enableRetrieval: Boolean(kb.bedrockKbId),
    });
  }

  async function onClone(kb: KnowledgeBase) {
    const suggested = `${kb.name}${kt('cloneSuffix', lang)}`;
    const name = window.prompt(kt('cloneName', lang), suggested);
    if (name === null) return;
    setBusyId(kb.id);
    try {
      const created = await apiPost<KnowledgeBase>(`/knowledge-bases/${encodeURIComponent(kb.id)}/clone`, { name: name.trim() || suggested });
      refetch();
      setTab('mine');
      openKb(created);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form || form.mode === 'view') return;
    setSaving(true);
    setNotice(null);
    try {
      const payload = {
        name: form.name,
        description: form.description,
        kind: form.kind,
        genre: form.kind === 'category' ? form.genre : '',
        markdown: form.markdown,
        reportSpec: form.reportSpec,
      };
      if (form.mode === 'edit' && form.id) {
        await apiPut(`/knowledge-bases/${encodeURIComponent(form.id)}`, payload);
      } else {
        await apiPost('/knowledge-bases', { ...payload, ...(form.enableRetrieval ? { enableRetrieval: true } : {}) });
        setTab('mine');
      }
      setForm(null);
      refetch();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function onArchive(kb: KnowledgeBase, archived: boolean) {
    if (archived && !window.confirm(kt('archiveConfirm', lang, { name: kb.name }))) return;
    setBusyId(kb.id);
    try {
      await apiPut(`/knowledge-bases/${encodeURIComponent(kb.id)}`, { archived });
      setInUse(null);
      refetch();
    } finally {
      setBusyId(null);
    }
  }

  /** 刪除防呆:先查使用情況;使用中 → 顯示引用清單(只能封存);未使用才二次確認後刪除。 */
  async function onDelete(kb: KnowledgeBase) {
    setBusyId(kb.id);
    setNotice(null);
    try {
      const usage = await apiGet<KbUsage>(`/knowledge-bases/${encodeURIComponent(kb.id)}/usage`);
      if (usage.total > 0) {
        setInUse({ kb, usage });
        return;
      }
      if (!window.confirm(kt('deleteConfirm', lang, { name: kb.name }))) return;
      await apiDelete(`/knowledge-bases/${encodeURIComponent(kb.id)}`);
      if (form?.id === kb.id) setForm(null);
      refetch();
    } catch (err) {
      // 後端仍會擋(例如剛被別人引用):409 時重新取使用清單顯示。
      if (err instanceof ApiError && err.status === 409) {
        const usage = await apiGet<KbUsage>(`/knowledge-bases/${encodeURIComponent(kb.id)}/usage`).catch(() => null);
        if (usage) setInUse({ kb, usage });
      } else {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusyId(null);
    }
  }

  const editingKb = form?.id ? items.find((k) => k.id === form.id) : undefined;
  const readOnly = form?.mode === 'view';
  const genreTemplate = form ? (readOnly ? editingKb?.reportProfile : templateFor(form.kind === 'category' ? form.genre || undefined : undefined)) : undefined;

  return (
    <section className="listpage listpage--wide kb">
      <header className="listpage__header kb__header">
        <div>
          <h1 className="listpage__title">{t('page.knowledge.title')}</h1>
          <p className="kb__intro">{kt('intro', lang)}</p>
        </div>
        {!form && (
          <button type="button" className="kb__create-btn" onClick={openCreate}>
            {kt('createBlank', lang)}
          </button>
        )}
      </header>

      {notice && <p className="listpage__error" role="alert">{notice}</p>}

      {form && (
        <form ref={formRef} className="kb__form" onSubmit={onSubmit}>
          <div className="kb__form-head">
            <h2 className="kb__form-title">
              {readOnly ? kt('editorView', lang) : form.mode === 'edit' ? kt('editorEdit', lang) : kt('editorCreate', lang)}
              {editingKb && <span className="kb__form-sub">{editingKb.name}</span>}
            </h2>
            <div className="kb__badges">
              {editingKb?.builtin && <span className="kb__builtin-badge">{kt('builtin', lang)} · {kt('readOnly', lang)}</span>}
              {editingKb?.version && <span className="kb__kind-badge">v{editingKb.version}</span>}
              {typeof editingKb?.revision === 'number' && <span className="kb__kind-badge">{kt('revision', lang)} r{editingKb.revision}</span>}
              {editingKb?.clonedFrom && (
                <span className="kb__kind-badge">{kt('basedOn', lang)} {editingKb.clonedFrom.name}{editingKb.clonedFrom.version ? ` v${editingKb.clonedFrom.version}` : ''}</span>
              )}
            </div>
          </div>

          {readOnly && (
            <div className="kb__readonly">
              <span>{kt('readOnlyHint', lang)}</span>
              {editingKb && (
                <button type="button" className="kb__submit" onClick={() => void onClone(editingKb)} disabled={busyId === editingKb.id}>
                  {kt('clone', lang)}
                </button>
              )}
            </div>
          )}

          <fieldset className="kb__section" disabled={readOnly}>
            <legend>{kt('secBasic', lang)}</legend>
            <div className="kb__form-grid">
              <label className="kb__field">
                <span className="kb__label">{kt('name', lang)}</span>
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('kb.namePlaceholder')} />
              </label>
              <label className="kb__field">
                <span className="kb__label">{kt('kind', lang)}</span>
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as KbKind })}>
                  <option value="category">{kt('kindCategory', lang)}</option>
                  <option value="scenario">{kt('kindScenario', lang)}</option>
                </select>
              </label>
              {form.kind === 'category' && (
                <div className="kb__field">
                  <span className="kb__label">{kt('genre', lang)}</span>
                  {readOnly ? (
                    <span className="kb__genre-static">
                      {form.genre && <GenreIcon genre={form.genre} size={16} />} {form.genre ? t(genreLabelKey(form.genre)) : '—'}
                    </span>
                  ) : (
                    <IconSelect
                      value={form.genre}
                      options={genreOptions(t)}
                      onChange={(v) => setForm({ ...form, genre: v as Genre })}
                      placeholder={kt('genre', lang)}
                      ariaLabel={kt('genre', lang)}
                    />
                  )}
                </div>
              )}
            </div>
            {form.kind === 'category' && !readOnly && <p className="kb__hint">{kt('genreHint', lang)}</p>}
            <label className="kb__field">
              <span className="kb__label">{kt('description', lang)}</span>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
          </fieldset>

          <fieldset className="kb__section" disabled={readOnly}>
            <legend>{kt('secKnowledge', lang)}</legend>
            <textarea
              className="kb__textarea kb__mono"
              rows={12}
              value={form.markdown}
              onChange={(e) => setForm({ ...form, markdown: e.target.value })}
              placeholder={kt('markdownHint', lang)}
              aria-label={kt('secKnowledge', lang)}
              spellCheck={false}
              readOnly={readOnly}
            />
            <span className="kb__hint">{kt('markdownHint', lang)}</span>
          </fieldset>

          <fieldset className="kb__section">
            <legend>{kt('secSpec', lang)}</legend>
            <KbSpecEditor
              spec={form.reportSpec}
              {...(!readOnly ? { onChange: (reportSpec: ReportSpecInput) => setForm({ ...form, reportSpec }) } : {})}
              {...(genreTemplate ? { genreTemplate } : {})}
              {...(globalTemplate ? { globalTemplate } : {})}
              lang={lang}
            />
          </fieldset>

          {form.mode === 'create' && (
            <label className="kb__checkbox-field">
              <input type="checkbox" checked={form.enableRetrieval} onChange={(e) => setForm({ ...form, enableRetrieval: e.target.checked })} />
              <span>
                {t('kb.enableRetrieval')}
                <span className="kb__hint kb__hint--block">{t('kb.enableRetrievalHint')}</span>
              </span>
            </label>
          )}

          <div className="kb__actions">
            <button type="button" className="kb__cancel" onClick={() => setForm(null)}>
              {readOnly ? kt('close', lang) : kt('cancel', lang)}
            </button>
            {!readOnly && (
              <button type="submit" className="kb__submit" disabled={saving || !form.name.trim()}>
                {saving ? kt('saving', lang) : form.mode === 'edit' ? kt('save', lang) : kt('create', lang)}
              </button>
            )}
          </div>

          {form.mode === 'edit' && form.id && (
            <RetrievalSection kb={editingKb} onProvisioned={refetch} />
          )}
        </form>
      )}

      {/* 分頁 + 搜尋 */}
      <div className="kb__tabs-bar">
        <div className="kb__tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'templates'} className={`kb__tab ${tab === 'templates' ? 'is-active' : ''}`} onClick={() => setTab('templates')}>
            {kt('tabTemplates', lang)} <span className="kb__tab-count">{templates.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'mine'} className={`kb__tab ${tab === 'mine' ? 'is-active' : ''}`} onClick={() => setTab('mine')}>
            {kt('tabMine', lang)} <span className="kb__tab-count">{mine.filter((k) => !k.archived).length}</span>
          </button>
        </div>
        <label className="kb__search">
          <span className="visually-hidden">{kt('search', lang)}</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={kt('search', lang)} />
        </label>
        {tab === 'mine' && (
          <label className="kb__inline">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {kt('showArchived', lang)}
          </label>
        )}
      </div>

      {loading && items.length === 0 ? (
        <div className="listpage__skeleton" aria-hidden="true">
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
        </div>
      ) : error ? (
        <p className="listpage__error" role="alert">{t('page.loadError')}</p>
      ) : tab === 'templates' ? (
        shownTemplates.length === 0 ? (
          <div className="listpage__empty"><p>{kt('noTemplatesMatch', lang)}</p></div>
        ) : (
          <ul className="kb__grid">
            {shownTemplates.map((kb) => {
              const p = kb.reportProfile;
              return (
                <li key={kb.id} className={`kb__card kb__card--template${busyId === kb.id ? ' kb__card--busy' : ''}`}>
                  <div className="kb__card-head">
                    <span className="kb__card-title">
                      {kb.genre && <GenreIcon genre={kb.genre} size={20} />}
                      <span className="kb__card-name" title={kb.name}>{kb.name}</span>
                    </span>
                    <span className="kb__badges">
                      <span className="kb__builtin-badge">{kt('builtin', lang)}</span>
                      {kb.version && <span className="kb__kind-badge">v{kb.version}</span>}
                      {kb.usage && kb.usage.apps + kb.usage.jobs > 0 && (
                        <span className="kb__usage-badge">{kt('inUse', lang)} · {kb.usage.apps} {kt('apps', lang)} / {kb.usage.jobs} {kt('jobs', lang)}</span>
                      )}
                    </span>
                  </div>
                  {kb.description && <p className="kb__card-desc">{kb.description}</p>}
                  {p && (
                    <ul className="kb__stats">
                      <li><b>{p.modules.length}</b> {kt('modules', lang)}</li>
                      <li><b>{p.observe.length}</b> {kt('observe', lang)}</li>
                      <li><b>{p.metrics.length}</b> {kt('metrics', lang)}</li>
                      <li><b>{p.riskRules.length + p.releaseRules.length}</b> {kt('riskRules', lang)}/{kt('releaseRules', lang)}</li>
                      {p.specValues.length > 0 && <li><b>{p.specValues.length}</b> {kt('specValues', lang)}</li>}
                    </ul>
                  )}
                  {p && p.specValues.length > 0 && (
                    <p className="kb__spec-preview">{p.specValues.map((v) => tr(v.label, lang)).join('、')}</p>
                  )}
                  <div className="kb__card-actions">
                    <button type="button" className="kb__card-btn" onClick={() => openKb(kb)}>{kt('view', lang)}</button>
                    <button type="button" className="kb__card-btn kb__card-btn--primary" onClick={() => void onClone(kb)} disabled={busyId === kb.id}>
                      {kt('clone', lang)}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : shownMine.length === 0 ? (
        <div className="listpage__empty"><p>{kt('noMine', lang)}</p></div>
      ) : (
        <ul className="kb__grid">
          {shownMine.map((kb) => {
            const used = (kb.usage?.apps ?? 0) + (kb.usage?.jobs ?? 0);
            return (
              <li key={kb.id} className={`kb__card${kb.archived ? ' kb__card--archived' : ''}${busyId === kb.id ? ' kb__card--busy' : ''}`}>
                <div className="kb__card-head">
                  <span className="kb__card-title">
                    {kb.genre && <GenreIcon genre={kb.genre} size={20} />}
                    <span className="kb__card-name" title={kb.name}>{kb.name}</span>
                  </span>
                  <span className="kb__badges">
                    {kb.archived && <span className="kb__archived-badge">{kt('archived', lang)}</span>}
                    <span className="kb__kind-badge">{kb.kind === 'category' ? (kb.genre ? t(genreLabelKey(kb.genre)) : kt('kindCategory', lang)) : kt('kindScenario', lang)}</span>
                    {typeof kb.revision === 'number' && <span className="kb__kind-badge">r{kb.revision}</span>}
                    {used > 0 && <span className="kb__usage-badge">{kt('inUse', lang)} · {kb.usage!.apps} {kt('apps', lang)} / {kb.usage!.jobs} {kt('jobs', lang)}</span>}
                    {kb.bedrockKbId && <span className="kb__retrieval-badge">{t('kb.retrievalOn')}</span>}
                  </span>
                </div>
                {kb.clonedFrom && (
                  <p className="kb__based">{kt('basedOn', lang)} {kb.clonedFrom.name}{kb.clonedFrom.version ? ` v${kb.clonedFrom.version}` : ''}{typeof kb.clonedFrom.revision === 'number' ? ` r${kb.clonedFrom.revision}` : ''}</p>
                )}
                {kb.description && <p className="kb__card-desc">{kb.description}</p>}
                <SpecSummary spec={kb.reportSpec} lang={lang} />
                <div className="kb__card-actions">
                  <button type="button" className="kb__card-btn" onClick={() => openKb(kb)}>{kt('edit', lang)}</button>
                  <button type="button" className="kb__card-btn" onClick={() => void onClone(kb)}>{kt('duplicate', lang)}</button>
                  <button type="button" className="kb__card-btn" onClick={() => void onArchive(kb, !kb.archived)}>
                    {kb.archived ? kt('unarchive', lang) : kt('archive', lang)}
                  </button>
                  <button
                    type="button"
                    className="kb__card-btn kb__card-btn--danger"
                    onClick={() => void onDelete(kb)}
                    title={used > 0 ? kt('inUseTitle', lang) : undefined}
                  >
                    {kt('delete', lang)}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {inUse && (
        <div className="kb__modal-backdrop" role="presentation" onClick={() => setInUse(null)}>
          <div className="kb__modal" role="alertdialog" aria-modal="true" aria-labelledby="kb-inuse-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="kb-inuse-title">{kt('inUseTitle', lang)}</h3>
            <p className="kb__modal-name">{inUse.kb.name}</p>
            <p>{kt('inUseBody', lang)}</p>
            {inUse.usage.apps.length > 0 && (
              <>
                <h4>{kt('usedByApps', lang)} ({inUse.usage.apps.length})</h4>
                <ul className="kb__modal-list">
                  {inUse.usage.apps.map((a) => (
                    <li key={a.appId}><Link to={`/apps/${encodeURIComponent(a.appId)}`}>{a.name}</Link></li>
                  ))}
                </ul>
              </>
            )}
            {inUse.usage.jobs.length > 0 && (
              <>
                <h4>{kt('usedByJobs', lang)} ({inUse.usage.jobs.length})</h4>
                <ul className="kb__modal-list">
                  {inUse.usage.jobs.slice(0, 12).map((j) => (
                    <li key={j.jobId}>
                      <Link to={`/reports/${encodeURIComponent(j.jobId)}`}>{j.jobId}</Link>
                      {j.createdAt && <small> · {new Date(j.createdAt).toLocaleString(locale)}</small>}
                      {j.state && <small> · {t(`state.${j.state}` as MessageKey)}</small>}
                    </li>
                  ))}
                  {inUse.usage.jobs.length > 12 && <li><small>… +{inUse.usage.jobs.length - 12}</small></li>}
                </ul>
              </>
            )}
            {inUse.usage.otherTenants.apps + inUse.usage.otherTenants.jobs > 0 && (
              <p className="kb__hint">{kt('otherTenants', lang, { a: inUse.usage.otherTenants.apps, j: inUse.usage.otherTenants.jobs })}</p>
            )}
            <div className="kb__actions">
              <button type="button" className="kb__cancel" onClick={() => setInUse(null)}>{kt('close', lang)}</button>
              {!inUse.kb.archived && (
                <button type="button" className="kb__submit" onClick={() => void onArchive(inUse.kb, true)}>{kt('archiveInstead', lang)}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** 卡片上的規格摘要(你改了什麼)。 */
function SpecSummary({ spec, lang }: { spec?: ReportSpecInput; lang: 'zh' | 'en' }) {
  if (!spec) return null;
  const parts: string[] = [];
  const v = Object.keys(spec.values ?? {}).length;
  const th = Object.keys(spec.thresholds ?? {}).length;
  const ob = spec.observe?.length ?? 0;
  const mo = spec.modules?.length ?? 0;
  const ex = Object.values(spec.exclude ?? {}).reduce((a, l) => a + (l?.length ?? 0), 0);
  if (v) parts.push(`${kt('specValues', lang)} ${v}`);
  if (th) parts.push(`${kt('thresholds', lang)} ${th}`);
  if (ob) parts.push(`${kt('observe', lang)} +${ob}`);
  if (mo) parts.push(`${kt('modules', lang)} +${mo}`);
  if (ex) parts.push(kt('disabledCount', lang, { n: ex }));
  return parts.length ? <p className="kb__spec-preview">{parts.join(' · ')}</p> : null;
}

/** 文件檢索:已接 → 文件面板;未接 → 啟用入口。 */
function RetrievalSection({ kb, onProvisioned }: { kb?: KnowledgeBase; onProvisioned: () => void }) {
  const { t } = useI18n();
  const [provisioning, setProvisioning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!kb) return null;
  if (kb.bedrockKbId) return <KbDocsPanel kbId={kb.id} />;
  async function onEnable() {
    if (!kb || !window.confirm(t('kb.enableRetrievalConfirm'))) return;
    setProvisioning(true);
    setErr(null);
    try {
      await apiPost(`/knowledge-bases/${encodeURIComponent(kb.id)}/provision`, {});
      onProvisioned();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setProvisioning(false);
    }
  }
  return (
    <div className="kb__docs">
      <div className="kb__docs-head"><span className="kb__label">{t('kb.docs')}</span></div>
      <p className="kb__hint kb__hint--block">{t('kb.enableRetrievalHint')}</p>
      <div className="kb__docs-actions">
        <button type="button" className="kb__card-btn" onClick={() => void onEnable()} disabled={provisioning}>
          {provisioning ? t('kb.enabling') : t('kb.enableRetrieval')}
        </button>
      </div>
      {err && <p className="listpage__error">{err}</p>}
    </div>
  );
}

/** 已接 Bedrock KB 的知識庫:文件上傳/刪除 + 同步 + ingestion 狀態。 */
function KbDocsPanel({ kbId }: { kbId: string }) {
  const { t } = useI18n();
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [ingestion, setIngestion] = useState<IngestionStatus | null>(null);
  const [uploading, setUploading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function loadDocs() {
    apiGet<ListResponse<KbDoc>>(`/knowledge-bases/${encodeURIComponent(kbId)}/docs`)
      .then((r) => setDocs(r.items))
      .catch(() => {});
  }
  function loadIngestion() {
    apiGet<IngestionStatus>(`/knowledge-bases/${encodeURIComponent(kbId)}/ingestion`)
      .then(setIngestion)
      .catch(() => {});
  }

  useEffect(() => {
    loadDocs();
    loadIngestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kbId]);

  const running = ingestion?.status === 'STARTING' || ingestion?.status === 'IN_PROGRESS';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(loadIngestion, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, kbId]);

  async function onUpload(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    try {
      for (const file of files) {
        const target = await apiPost<{ url: string; key: string }>(
          `/knowledge-bases/${encodeURIComponent(kbId)}/docs/presign`,
          { filename: file.name },
        );
        await uploadToS3(target.url, file);
      }
      loadDocs();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function onRemoveDoc(key: string) {
    await apiDelete(`/knowledge-bases/${encodeURIComponent(kbId)}/docs?key=${encodeURIComponent(key)}`);
    loadDocs();
  }

  async function onSync() {
    setSyncing(true);
    try {
      await apiPost(`/knowledge-bases/${encodeURIComponent(kbId)}/sync`, {});
      loadIngestion();
    } finally {
      setSyncing(false);
    }
  }

  function ingestLabel(): string {
    const s = ingestion?.status;
    if (s === 'COMPLETE') return t('kb.ingestComplete');
    if (s === 'FAILED') return t('kb.ingestFailed');
    if (s === 'STARTING' || s === 'IN_PROGRESS') return t('kb.ingestRunning');
    return t('kb.ingestNone');
  }

  return (
    <div className="kb__docs">
      <div className="kb__docs-head">
        <span className="kb__label">{t('kb.docs')} ({docs.length})</span>
        <span className={`kb__ingest kb__ingest--${ingestion?.status ?? 'none'}`}>{ingestLabel()}</span>
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".pdf,.md,.markdown,.txt,.html,.htm,.doc,.docx,.csv,.json"
        className="visually-hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void onUpload(files);
        }}
      />
      <div className="kb__docs-actions">
        <button type="button" className="kb__card-btn" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? t('kb.uploading') : t('kb.uploadDoc')}
        </button>
        <button type="button" className="kb__card-btn" onClick={() => void onSync()} disabled={syncing || running}>
          {syncing || running ? t('kb.syncing') : t('kb.sync')}
        </button>
      </div>
      {docs.length === 0 ? (
        <p className="kb__hint">{t('kb.noDocs')}</p>
      ) : (
        <ul className="kb__doc-list">
          {docs.map((d) => (
            <li key={d.key} className="kb__doc-item">
              <span className="kb__doc-name">{d.name}</span>
              <button type="button" className="kb__doc-remove" onClick={() => void onRemoveDoc(d.key)}>{t('kb.removeDoc')}</button>
            </li>
          ))}
        </ul>
      )}
      {ingestion?.status === 'FAILED' && ingestion.failureReasons?.length ? (
        <p className="listpage__error">{ingestion.failureReasons.join('; ')}</p>
      ) : null}
      <p className="kb__hint">{t('kb.syncHint')}</p>
    </div>
  );
}
