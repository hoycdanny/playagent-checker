import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
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
import './ListPage.css';
import './KnowledgePage.css';

type KbKind = 'category' | 'scenario';

interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  kind: KbKind;
  genre?: Genre;
  markdown: string;
  /** true = 平台內建(唯讀,不可編輯/刪除)。 */
  builtin?: boolean;
  /** Stage B:有值代表已接 Bedrock KB 文件檢索。 */
  bedrockKbId?: string;
  createdAt: string;
  updatedAt?: string;
}

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

interface FormState {
  editingId: string | null;
  name: string;
  description: string;
  kind: KbKind;
  genre: '' | Genre;
  markdown: string;
  enableRetrieval: boolean;
}

const EMPTY_FORM: FormState = {
  editingId: null,
  name: '',
  description: '',
  kind: 'category',
  genre: '',
  markdown: '',
  enableRetrieval: false,
};

function genreOptions(t: (k: MessageKey) => string): IconSelectOption[] {
  return GENRES.map((g) => ({
    value: g,
    label: t(genreLabelKey(g)),
    icon: <GenreIcon genre={g} size={16} />,
  }));
}

export default function KnowledgePage() {
  const { t } = useI18n();
  const { data, loading, error, refetch } = useQuery<ListResponse<KnowledgeBase>>(
    'knowledge-bases',
    () => apiGet<ListResponse<KnowledgeBase>>('/knowledge-bases'),
  );

  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KbKind | 'all'>('all');

  const items = data?.items ?? [];
  const filtered = useMemo(
    () => (kindFilter === 'all' ? items : items.filter((k) => k.kind === kindFilter)),
    [items, kindFilter],
  );

  const editing = form?.editingId != null;
  const editingHasRetrieval = Boolean(
    form?.editingId && items.find((k) => k.id === form.editingId)?.bedrockKbId,
  );
  // 內建知識庫唯讀:表單以「檢視」模式開啟,禁用所有輸入與儲存。
  const readOnly = Boolean(
    form?.editingId && items.find((k) => k.id === form.editingId)?.builtin,
  );

  // 表單開啟時捲動到表單處:表單是 inline 展開在頁面上方,若使用者從下方卡片按「編輯」,
  // 不捲動就會看不到彈出的表單而誤操作。
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (form) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [form]);

  function openCreate() {
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(kb: KnowledgeBase) {
    setForm({
      editingId: kb.id,
      name: kb.name,
      description: kb.description ?? '',
      kind: kb.kind,
      genre: kb.genre ?? '',
      markdown: kb.markdown ?? '',
      enableRetrieval: Boolean(kb.bedrockKbId),
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        description: form.description,
        kind: form.kind,
        genre: form.kind === 'category' ? form.genre : '',
        markdown: form.markdown,
      };
      if (form.editingId) {
        await apiPut(`/knowledge-bases/${encodeURIComponent(form.editingId)}`, payload);
      } else {
        // 建立時若勾選文件檢索,後端會 runtime 建 Bedrock KB(有雲資源與成本)。
        await apiPost('/knowledge-bases', {
          ...payload,
          ...(form.enableRetrieval ? { enableRetrieval: true } : {}),
        });
      }
      setForm(null);
      refetch();
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(kb: KnowledgeBase) {
    if (!window.confirm(t('kb.deleteConfirm'))) return;
    setBusyId(kb.id);
    try {
      await apiDelete(`/knowledge-bases/${encodeURIComponent(kb.id)}`);
      refetch();
    } finally {
      setBusyId(null);
    }
  }

  // 對「既有的」Markdown 知識庫啟用文件檢索(建 Bedrock 向量 KB)。成功後重載,
  // editingHasRetrieval 轉真 → 顯示文件上傳面板。
  const [provisioning, setProvisioning] = useState(false);
  const [provisionErr, setProvisionErr] = useState<string | null>(null);
  async function onEnableRetrieval() {
    if (!form?.editingId) return;
    if (!window.confirm(t('kb.enableRetrievalConfirm'))) return;
    setProvisioning(true);
    setProvisionErr(null);
    try {
      await apiPost(`/knowledge-bases/${encodeURIComponent(form.editingId)}/provision`, {});
      await refetch();
    } catch (err) {
      setProvisionErr(err instanceof Error ? err.message : String(err));
    } finally {
      setProvisioning(false);
    }
  }

  return (
    <section className="listpage kb">
      <header className="listpage__header kb__header">
        <div>
          <h1 className="listpage__title">{t('page.knowledge.title')}</h1>
          {items.length > 0 && (
            <span className="kb__count">
              {items.length} {t('kb.count')}
            </span>
          )}
        </div>
        {!form && (
          <button type="button" className="kb__create-btn" onClick={openCreate}>
            {t('kb.create')}
          </button>
        )}
      </header>

      {form && (
        <form ref={formRef} className="kb__form" onSubmit={onSubmit}>
          <h2 className="kb__form-title">
            {readOnly ? t('kb.viewTitle') : editing ? t('kb.editTitle') : t('kb.create')}
          </h2>

          {readOnly && <p className="kb__hint kb__hint--block">{t('kb.builtinReadonly')}</p>}

          <div className="kb__form-grid">
            <label className="kb__field">
              <span className="kb__label">{t('kb.name')}</span>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('kb.namePlaceholder')}
                readOnly={readOnly}
                disabled={readOnly}
              />
            </label>

            <label className="kb__field">
              <span className="kb__label">{t('kb.kind')}</span>
              <select
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as KbKind })}
                disabled={readOnly}
              >
                <option value="category">{t('kb.kindCategory')}</option>
                <option value="scenario">{t('kb.kindScenario')}</option>
              </select>
            </label>

            {form.kind === 'category' && (
              <div className="kb__field">
                <span className="kb__label">{t('kb.genre')}</span>
                <IconSelect
                  value={form.genre}
                  options={genreOptions(t)}
                  onChange={(v) => setForm({ ...form, genre: v as Genre })}
                  placeholder={t('kb.genre')}
                  ariaLabel={t('kb.genre')}
                />
              </div>
            )}
          </div>

          <label className="kb__field">
            <span className="kb__label">{t('kb.description')}</span>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              readOnly={readOnly}
              disabled={readOnly}
            />
          </label>

          <label className="kb__field">
            <span className="kb__label">{t('kb.markdown')}</span>
            <textarea
              className="kb__textarea kb__mono"
              rows={14}
              value={form.markdown}
              onChange={(e) => setForm({ ...form, markdown: e.target.value })}
              placeholder={t('kb.markdownHint')}
              spellCheck={false}
              readOnly={readOnly}
            />
            {!readOnly && <span className="kb__hint">{t('kb.markdownHint')}</span>}
          </label>

          {/* 文件檢索(Bedrock KB)—— 只在建立時可勾(會建雲資源)。 */}
          {!editing && (
            <label className="kb__checkbox-field">
              <input
                type="checkbox"
                checked={form.enableRetrieval}
                onChange={(e) => setForm({ ...form, enableRetrieval: e.target.checked })}
              />
              <span>
                {t('kb.enableRetrieval')}
                <span className="kb__hint kb__hint--block">{t('kb.enableRetrievalHint')}</span>
              </span>
            </label>
          )}

          <div className="kb__actions">
            <button type="button" className="kb__cancel" onClick={() => setForm(null)}>
              {readOnly ? t('kb.close') : t('kb.cancel')}
            </button>
            {!readOnly && (
              <button type="submit" className="kb__submit" disabled={saving || !form.name.trim()}>
                {saving ? t('kb.saving') : editing ? t('kb.saveEdit') : t('kb.save')}
              </button>
            )}
          </div>

          {/* 已接 Bedrock KB:顯示文件上傳/同步面板 */}
          {editing && editingHasRetrieval && <KbDocsPanel kbId={form.editingId!} />}

          {/* 既有 KB 尚未接檢索(非內建):提供「啟用文件檢索」入口,補開後即可上傳 PDF/文件 */}
          {editing && !editingHasRetrieval && !readOnly && (
            <div className="kb__docs">
              <div className="kb__docs-head">
                <span className="kb__label">{t('kb.docs')}</span>
              </div>
              <p className="kb__hint kb__hint--block">{t('kb.enableRetrievalHint')}</p>
              <div className="kb__docs-actions">
                <button
                  type="button"
                  className="kb__card-btn"
                  onClick={() => void onEnableRetrieval()}
                  disabled={provisioning}
                >
                  {provisioning ? t('kb.enabling') : t('kb.enableRetrieval')}
                </button>
              </div>
              {provisionErr && <p className="listpage__error">{provisionErr}</p>}
            </div>
          )}
        </form>
      )}

      {!form && items.length > 0 && (
        <div className="kb__toolbar">
          <label className="kb__filter">
            <span className="visually-hidden">{t('kb.filterKind')}</span>
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as KbKind | 'all')}
            >
              <option value="all">{t('kb.filterAll')}</option>
              <option value="category">{t('kb.kindCategory')}</option>
              <option value="scenario">{t('kb.kindScenario')}</option>
            </select>
          </label>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="listpage__skeleton" aria-hidden="true">
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
        </div>
      ) : error ? (
        <p className="listpage__error" role="alert">
          {t('page.loadError')}
        </p>
      ) : items.length === 0 ? (
        <div className="listpage__empty">
          <p>{t('page.knowledge.empty')}</p>
        </div>
      ) : (
        <ul className="kb__grid">
          {filtered.map((kb) => (
            <li key={kb.id} className={`kb__card${busyId === kb.id ? ' kb__card--busy' : ''}`}>
              <div className="kb__card-head">
                <span className="kb__card-name" title={kb.name}>
                  {kb.name}
                </span>
                <span className="kb__badges">
                  {kb.builtin && (
                    <span className="kb__builtin-badge">{t('kb.builtin')}</span>
                  )}
                  <span className="kb__kind-badge">
                    {kb.kind === 'category' ? t('kb.kindCategory') : t('kb.kindScenario')}
                  </span>
                  {kb.kind === 'category' && kb.genre && (
                    <span className="kb__genre-badge" title={t(genreLabelKey(kb.genre))}>
                      <GenreIcon genre={kb.genre} size={13} />
                      {t(genreLabelKey(kb.genre))}
                    </span>
                  )}
                  {kb.bedrockKbId && (
                    <span className="kb__retrieval-badge">{t('kb.retrievalOn')}</span>
                  )}
                </span>
              </div>
              {kb.description && <p className="kb__card-desc">{kb.description}</p>}
              <div className="kb__card-actions">
                <button
                  type="button"
                  className="kb__card-btn"
                  onClick={() => openEdit(kb)}
                  disabled={busyId === kb.id}
                >
                  {kb.builtin ? t('kb.view') : t('kb.edit')}
                </button>
                {!kb.builtin && (
                  <button
                    type="button"
                    className="kb__card-btn kb__card-btn--danger"
                    onClick={() => void onDelete(kb)}
                    disabled={busyId === kb.id}
                  >
                    {t('kb.delete')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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

  // ingestion 進行中時輪詢。
  const running =
    ingestion?.status === 'STARTING' || ingestion?.status === 'IN_PROGRESS';
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
    await apiDelete(
      `/knowledge-bases/${encodeURIComponent(kbId)}/docs?key=${encodeURIComponent(key)}`,
    );
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
        <span className="kb__label">
          {t('kb.docs')} ({docs.length})
        </span>
        <span className={`kb__ingest kb__ingest--${ingestion?.status ?? 'none'}`}>
          {ingestLabel()}
        </span>
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
        <button
          type="button"
          className="kb__card-btn"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? t('kb.uploading') : t('kb.uploadDoc')}
        </button>
        <button
          type="button"
          className="kb__card-btn"
          onClick={() => void onSync()}
          disabled={syncing || running}
        >
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
              <button
                type="button"
                className="kb__doc-remove"
                onClick={() => void onRemoveDoc(d.key)}
              >
                {t('kb.removeDoc')}
              </button>
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
