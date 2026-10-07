import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  ApiError,
  uploadToS3,
  type ListResponse,
  type UploadTarget,
} from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import GenreIcon, { GENRES, genreLabelKey, type Genre } from '../components/GenreIcon.tsx';
import IconSelect, { type IconSelectOption } from '../components/IconSelect.tsx';
import AppsCostPanel, { type CostResponse } from '../components/apps/AppsCostPanel.tsx';
import Sparkline from '../components/charts/Sparkline.tsx';
import './ListPage.css';
import './AppsPage.css';

type Platform = 'android' | 'ios' | 'windows' | 'web';

interface AppRecord {
  id: string;
  name: string;
  platform: Platform;
  identifier?: string;
  genre?: Genre;
  /** 次要類型(如 RPG + Action);報告引擎合併各類型 profile。 */
  secondaryGenres?: Genre[];
  version?: string;
  artifactId?: string;
  /** 已上傳的版本清單(多版本 APK/IPA/EXE);後端對舊資料會補成一筆。 */
  builds?: Array<{ artifactId: string; label: string }>;
  iconArtifactId?: string;
  /** 由後端簽發的限時圖示 URL(小截圖直顯)。 */
  iconUrl?: string;
  notes?: string;
  defaultKnowledgeBaseIds?: string[];
  createdAt: string;
  updatedAt?: string;
}

const PLATFORMS: { value: Platform; labelKey: MessageKey }[] = [
  { value: 'android', labelKey: 'platform.android' },
  { value: 'ios', labelKey: 'platform.ios' },
  { value: 'windows', labelKey: 'platform.windows' },
  { value: 'web', labelKey: 'platform.web' },
];

/** 依平台決定要上傳的產物類型;web 無需上傳。 */
function artifactKindFor(platform: Platform): 'apk' | 'ipa' | 'zip' | null {
  // Windows 的 'zip' 代表「遊戲檔」:上傳時依副檔名改送 exe(安裝檔)或 zip(免安裝資料夾)。
  if (platform === 'android') return 'apk';
  if (platform === 'ios') return 'ipa';
  if (platform === 'windows') return 'zip';
  return null;
}

type UploadState = 'idle' | 'done' | 'failed';

/** 表單狀態(建立與編輯共用)。editingId 為 null 代表建立模式。 */
interface FormState {
  editingId: string | null;
  name: string;
  platform: Platform;
  identifier: string;
  genre: '' | Genre;
  secondaryGenres: Genre[];
  version: string;
  notes: string;
  defaultKnowledgeBaseIds: string[];
  artifactId?: string;
  iconArtifactId?: string;
  /** 編輯時保留原圖示 URL 供預覽。 */
  iconUrl?: string;
}

const EMPTY_FORM: FormState = {
  editingId: null,
  name: '',
  platform: 'android',
  identifier: '',
  genre: '',
  secondaryGenres: [],
  version: '',
  notes: '',
  defaultKnowledgeBaseIds: [],
};

/** 次要類型上限(對齊後端 SECONDARY_GENRES_MAX)。 */
const SECONDARY_GENRES_MAX = 3;

/** 遊戲類型下拉選項(帶 SVG 圖示)。 */
function genreOptions(t: (k: MessageKey) => string): IconSelectOption[] {
  return GENRES.map((g) => ({
    value: g,
    label: t(genreLabelKey(g)),
    icon: <GenreIcon genre={g} size={16} />,
  }));
}

export default function AppsPage() {
  const { t } = useI18n();
  const { data, loading, error, refetch } = useQuery<ListResponse<AppRecord>>(
    'apps',
    () => apiGet<ListResponse<AppRecord>>('/apps'),
  );
  const kbQuery = useQuery<ListResponse<{ id: string; name: string; archived?: boolean }>>(
    'knowledge-bases',
    () => apiGet<ListResponse<{ id: string; name: string; archived?: boolean }>>('/knowledge-bases'),
  );
  const kbs = kbQuery.data?.items ?? [];

  // 成本:和「成本分析」頁共用同一個 useQuery key(cost:30),避免重複打那支要掃全部任務的 API。
  const costQuery = useQuery<CostResponse>('cost:30', () => apiGet<CostResponse>('/cost?days=30'));
  const daily = costQuery.data?.daily;
  // 通過率:取最近 200 筆任務(後端上限)分組算。這是「近期」通過率,不是全期間。
  const taskQuery = useQuery<ListResponse<{ appId: string; state: string }>>(
    'tasks:200',
    () => apiGet<ListResponse<{ appId: string; state: string }>>('/tasks?limit=200'),
  );

  const [form, setForm] = useState<FormState | null>(null);
  const [artifactPct, setArtifactPct] = useState<number | null>(null);
  const [artifactState, setArtifactState] = useState<UploadState>('idle');
  const [iconPct, setIconPct] = useState<number | null>(null);
  const [iconState, setIconState] = useState<UploadState>('idle');
  const [iconPreview, setIconPreview] = useState<string | undefined>();
  // 偵測到上傳的是 XAPK / split bundle:非錯誤,提示使用者系統會在執行時自動合併成單一 APK。
  const [xapkDetected, setXapkDetected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // 搜尋 + 平台 + 類型篩選(測試人員清單越長越需要)。
  const [search, setSearch] = useState('');
  const [platformFilter, setPlatformFilter] = useState<Platform | 'all'>('all');
  const [genreFilter, setGenreFilter] = useState<Genre | 'all'>('all');

  const items = data?.items ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((app) => {
      if (platformFilter !== 'all' && app.platform !== platformFilter) return false;
      if (genreFilter !== 'all' && app.genre !== genreFilter) return false;
      if (!q) return true;
      return (
        app.name.toLowerCase().includes(q) ||
        (app.identifier?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [items, search, platformFilter, genreFilter]);

  const appNames = useMemo(
    () => new Map(items.map((a) => [a.id, a.name] as const)),
    [items],
  );

  /** 每個應用的卡片指標:近 30 天花費／次數、近期通過率、日花費序列(走勢圖)。 */
  const cardStats = useMemo(() => {
    const m = new Map<string, { spendUsd: number; runs: number; passRate: number | null; spark: number[] }>();
    const decided = new Map<string, { decided: number; passed: number }>();
    for (const x of taskQuery.data?.items ?? []) {
      if (x.state !== 'pass' && x.state !== 'fail') continue;
      const cur = decided.get(x.appId) ?? { decided: 0, passed: 0 };
      cur.decided += 1;
      if (x.state === 'pass') cur.passed += 1;
      decided.set(x.appId, cur);
    }
    for (const a of items) {
      const c = daily?.byApp.find((x) => x.appId === a.id);
      const d = decided.get(a.id);
      m.set(a.id, {
        spendUsd: c?.totalUsd ?? 0,
        runs: c?.runs ?? 0,
        passRate: d && d.decided > 0 ? Math.round((d.passed / d.decided) * 100) : null,
        spark: (daily?.days ?? []).map((day) => day.byApp?.[a.id] ?? 0),
      });
    }
    return m;
  }, [items, daily, taskQuery.data]);

  const editing = form?.editingId != null;
  const kind = form ? artifactKindFor(form.platform) : null;

  function resetUploads() {
    setArtifactPct(null);
    setArtifactState('idle');
    setIconPct(null);
    setIconState('idle');
    setIconPreview(undefined);
    setXapkDetected(false);
  }

  /**
   * 偵測檔案是否為 XAPK / split bundle(需在執行時合併成單一 APK)。
   * 判準:副檔名為 .xapk/.apkm/.apks,或是 ZIP(PK\x03\x04)且內含 ≥1 個 .apk 項目。
   * 只讀檔頭幾 KB + 掃描是否出現 ".apk" 位元組樣式,足以做前端即時提示(權威判斷仍在 runner)。
   */
  async function detectXapkClient(file: File): Promise<boolean> {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.xapk') || lower.endsWith('.apkm') || lower.endsWith('.apks')) return true;
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
      if (!isZip) return false;
      // 掃描整個檔案的 UTF-8 位元組流找 "base.apk"/"config.*.apk"/"*.apk" 項目名。
      // 單一標準 APK 內不會有 ".apk" 檔名項目;XAPK 才有。大檔只掃前後段以省記憶體。
      const needle = '.apk';
      const chunkText = async (blob: Blob) => new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
      const size = file.size;
      const headText = await chunkText(file.slice(0, Math.min(size, 512 * 1024)));
      if (headText.includes(needle)) return true;
      // ZIP 的中央目錄在檔尾,檔名清單通常在那;掃末段更可靠。
      if (size > 512 * 1024) {
        const tailText = await chunkText(file.slice(Math.max(0, size - 512 * 1024)));
        if (tailText.includes(needle)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // 表單 inline 展開於頁面上方;從下方卡片按「編輯」時捲動到表單,避免看不到而誤操作。
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (form) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [form]);

  function openCreate() {
    resetUploads();
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(app: AppRecord) {
    resetUploads();
    setForm({
      editingId: app.id,
      name: app.name,
      platform: app.platform,
      identifier: app.identifier ?? '',
      genre: app.genre ?? '',
      secondaryGenres: app.secondaryGenres ?? [],
      version: app.version ?? '',
      notes: app.notes ?? '',
      defaultKnowledgeBaseIds: app.defaultKnowledgeBaseIds ?? [],
      artifactId: app.artifactId,
      iconArtifactId: app.iconArtifactId,
      iconUrl: app.iconUrl,
    });
    setIconPreview(app.iconUrl);
    if (app.artifactId) setArtifactState('done');
  }

  function closeForm() {
    setForm(null);
    resetUploads();
  }

  async function onUploadArtifact(file: File) {
    if (!kind) return;
    setArtifactState('idle');
    setArtifactPct(0);
    // 先在本地偵測是否為 XAPK(僅 Android 相關);是的話標記,讓 UI 提示「執行時會自動合併」。
    setXapkDetected(kind === 'apk' ? await detectXapkClient(file) : false);
    try {
      const uploadKind = kind === 'zip' && file.name.toLowerCase().endsWith('.exe') ? 'exe' : kind;
      const target = await apiPost<UploadTarget>('/uploads', { kind: uploadKind });
      await uploadToS3(target.url, file, setArtifactPct);
      setForm((f) => (f ? { ...f, artifactId: target.artifactId } : f));
      setArtifactState('done');
    } catch {
      setArtifactState('failed');
      setArtifactPct(null);
    }
  }

  async function onUploadIcon(file: File) {
    setIconState('idle');
    setIconPct(0);
    // 本地即時預覽(不必等雲端)。
    setIconPreview(URL.createObjectURL(file));
    try {
      const target = await apiPost<UploadTarget>('/uploads', { kind: 'png' });
      await uploadToS3(target.url, file, setIconPct);
      setForm((f) => (f ? { ...f, iconArtifactId: target.artifactId } : f));
      setIconState('done');
    } catch {
      setIconState('failed');
      setIconPct(null);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        platform: form.platform,
        identifier: form.identifier,
        genre: form.genre, // '' 代表清除/不設定
        secondaryGenres: form.secondaryGenres.filter((g) => g !== form.genre),
        version: form.version,
        notes: form.notes,
        defaultKnowledgeBaseIds: form.defaultKnowledgeBaseIds,
        ...(form.artifactId !== undefined ? { artifactId: form.artifactId } : {}),
        ...(form.iconArtifactId !== undefined
          ? { iconArtifactId: form.iconArtifactId }
          : {}),
      };
      if (form.editingId) {
        await apiPut(`/apps/${encodeURIComponent(form.editingId)}`, payload);
      } else {
        await apiPost('/apps', payload);
      }
      closeForm();
      refetch();
    } finally {
      setSaving(false);
    }
  }

  // 刪工作區會連帶永久刪除底下所有資料 → 要求輸入名稱確認。
  // 資料多時後端一次做不完(回 done:false),這裡接著再呼叫直到刪完。
  async function onDelete(app: AppRecord) {
    const typed = window.prompt(t('apps.deleteConfirm').replace('{name}', app.name));
    if (typed === null) return;
    if (typed.trim() !== app.name.trim()) {
      window.alert(t('apps.deleteNameMismatch'));
      return;
    }
    setBusyId(app.id);
    try {
      for (let i = 0; i < 20; i++) {
        const res = await apiDelete<{ done?: boolean }>(`/apps/${encodeURIComponent(app.id)}`);
        if (res.done !== false) break;
      }
    } catch (err) {
      const running = err instanceof ApiError && err.status === 409 ? err.message.match(/\d+/)?.[0] : undefined;
      window.alert(
        running
          ? t('apps.deleteRunning').replace('{n}', running)
          : t('apps.deleteFailed').replace('{msg}', err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setBusyId(null);
      refetch();
    }
  }

  return (
    <section className="listpage listpage--wide apps">
      <header className="listpage__header apps__header">
        <div>
          <h1 className="listpage__title">{t('page.apps.title')}</h1>
          {items.length > 0 && (
            <span className="apps__count">
              {items.length} {t('apps.count')}
            </span>
          )}
        </div>
        {!form && (
          <button type="button" className="apps__create-btn" onClick={openCreate}>
            {t('apps.create')}
          </button>
        )}
      </header>

      {form && (
        <form ref={formRef} className="apps__form" onSubmit={onSubmit}>
          <h2 className="apps__form-title">
            {editing ? t('apps.editTitle') : t('apps.create')}
          </h2>

          <div className="apps__form-grid">
            <label className="apps__field">
              <span className="apps__label">{t('apps.name')}</span>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>

            <label className="apps__field">
              <span className="apps__label">{t('apps.platform')}</span>
              <select
                value={form.platform}
                onChange={(e) => {
                  const platform = e.target.value as Platform;
                  // 切換平台時清掉不適用的產物上傳狀態。
                  setForm({ ...form, platform, artifactId: undefined });
                  setArtifactState('idle');
                  setArtifactPct(null);
                }}
              >
                {PLATFORMS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {t(p.labelKey)}
                  </option>
                ))}
              </select>
            </label>

            <div className="apps__field">
              <span className="apps__label">{t('apps.genre')}</span>
              <IconSelect
                value={form.genre}
                options={genreOptions(t)}
                onChange={(v) => setForm({ ...form, genre: v as Genre })}
                placeholder={t('apps.genrePlaceholder')}
                ariaLabel={t('apps.genre')}
              />
            </div>

            <div className="apps__field">
              <span className="apps__label">{t('apps.secondaryGenres')}</span>
              {form.secondaryGenres.length > 0 && (
                <ul className="apps__genre-chips">
                  {form.secondaryGenres.map((g) => (
                    <li key={g} className="apps__genre">
                      <GenreIcon genre={g} size={13} />
                      {t(genreLabelKey(g))}
                      <button
                        type="button"
                        className="apps__genre-remove"
                        aria-label={`${t('apps.secondaryGenresRemove')} ${t(genreLabelKey(g))}`}
                        onClick={() => setForm({ ...form, secondaryGenres: form.secondaryGenres.filter((x) => x !== g) })}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {form.secondaryGenres.length < SECONDARY_GENRES_MAX && (
                <IconSelect
                  value=""
                  options={genreOptions(t).filter((o) => o.value !== form.genre && !form.secondaryGenres.includes(o.value as Genre))}
                  onChange={(v) => {
                    if (v) setForm({ ...form, secondaryGenres: [...form.secondaryGenres, v as Genre] });
                  }}
                  placeholder={t('apps.secondaryGenresAdd')}
                  ariaLabel={t('apps.secondaryGenres')}
                />
              )}
              <span className="apps__hint">{t('apps.secondaryGenresHint')}</span>
            </div>

            <label className="apps__field">
              <span className="apps__label">{t('apps.version')}</span>
              <input
                value={form.version}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
                placeholder={t('apps.versionHint')}
              />
            </label>

            {(form.platform === 'android' || form.platform === 'ios') && (
              <label className="apps__field">
                <span className="apps__label">{t('apps.identifier')}</span>
                <input
                  value={form.identifier}
                  onChange={(e) => setForm({ ...form, identifier: e.target.value })}
                  placeholder={
                    form.platform === 'android'
                      ? t('apps.identifierHintAndroid')
                      : t('apps.identifierHintIos')
                  }
                />
                <span className="apps__hint">{t('apps.identifierFallbackHint')}</span>
              </label>
            )}

            {/* Web:用 identifier 欄位存「測試網址」,web runner 會以此為起始 URL(case 未指定 url 時)。 */}
            {form.platform === 'web' && (
              <label className="apps__field">
                <span className="apps__label">{t('apps.webUrl')}</span>
                <input
                  type="url"
                  inputMode="url"
                  value={form.identifier}
                  onChange={(e) => setForm({ ...form, identifier: e.target.value })}
                  placeholder={t('apps.webUrlHint')}
                />
                <span className="apps__hint">{t('apps.webUrlFallbackHint')}</span>
              </label>
            )}
          </div>

          {/* 圖示 / 代表截圖 */}
          <div className="apps__field">
            <span className="apps__label">{t('apps.icon')}</span>
            <div className="apps__icon-row">
              <div className="apps__icon-preview" aria-hidden={!iconPreview}>
                {iconPreview ? (
                  <img src={iconPreview} alt={t('apps.iconAlt')} />
                ) : (
                  <span className="apps__icon-empty">{t('apps.iconPlaceholder')}</span>
                )}
              </div>
              <div className="apps__icon-controls">
                <label className="apps__upload">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="visually-hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onUploadIcon(f);
                    }}
                  />
                  <span className="apps__upload-btn">
                    {iconPreview ? t('apps.iconChange') : t('apps.iconUpload')}
                  </span>
                </label>
                <span className="apps__hint">{t('apps.iconHint')}</span>
                {iconPct !== null && iconState === 'idle' && (
                  <span className="apps__upload-status" role="status">
                    {t('apps.uploading')} {iconPct}%
                  </span>
                )}
                {iconState === 'done' && (
                  <span className="apps__upload-status apps__upload-ok" role="status">
                    ✓ {t('apps.uploadDone')}
                  </span>
                )}
                {iconState === 'failed' && (
                  <span className="apps__upload-status apps__upload-err" role="alert">
                    {t('apps.uploadFailed')}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* 被測產物(非 web) */}
          {kind && (
            <div className="apps__field">
              <span className="apps__label">{t('apps.artifact')}</span>
              <div className="apps__icon-controls">
                <label className="apps__upload">
                  <input
                    type="file"
                    className="visually-hidden"
                    {...(kind === 'apk' ? { accept: '.apk,.xapk,.apkm,.apks' } : kind === 'zip' ? { accept: '.exe,.zip' } : {})}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onUploadArtifact(f);
                    }}
                  />
                  <span className="apps__upload-btn">{t('apps.uploadFile')}</span>
                </label>
                {kind === 'apk' && <span className="apps__hint">{t('apps.apkHint')}</span>}
                {kind === 'zip' && <span className="apps__hint">{t('apps.winHint')}</span>}
                {artifactPct !== null && artifactState === 'idle' && (
                  <span className="apps__upload-status" role="status">
                    {t('apps.uploading')} {artifactPct}%
                  </span>
                )}
                {artifactState === 'done' && (
                  <span className="apps__upload-status apps__upload-ok" role="status">
                    ✓ {t('apps.uploadDone')}
                  </span>
                )}
                {artifactState === 'failed' && (
                  <span className="apps__upload-status apps__upload-err" role="alert">
                    {t('apps.uploadFailed')}
                  </span>
                )}
                {xapkDetected && artifactState === 'done' && (
                  <span className="apps__upload-status apps__upload-ok" role="status">
                    {t('apps.xapkDetected')}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 測試備註 */}
          <label className="apps__field">
            <span className="apps__label">{t('apps.notes')}</span>
            <textarea
              className="apps__textarea"
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder={t('apps.notesHint')}
            />
          </label>

          {/* 預設知識庫(建立此 App 的測試時預選) */}
          {kbs.length > 0 && (
            <div className="apps__field">
              <span className="apps__label">{t('apps.defaultKnowledgeBases')}</span>
              <div className="apps__kb-list">
                {kbs.filter((kb) => !kb.archived || form.defaultKnowledgeBaseIds.includes(kb.id)).map((kb) => (
                  <label key={kb.id} className="apps__kb-option">
                    <input
                      type="checkbox"
                      checked={form.defaultKnowledgeBaseIds.includes(kb.id)}
                      onChange={(e) => {
                        setForm((f) =>
                          f
                            ? {
                                ...f,
                                defaultKnowledgeBaseIds: e.target.checked
                                  ? [...f.defaultKnowledgeBaseIds, kb.id]
                                  : f.defaultKnowledgeBaseIds.filter((id) => id !== kb.id),
                              }
                            : f,
                        );
                      }}
                    />
                    <span>{kb.name}</span>
                  </label>
                ))}
              </div>
              <span className="apps__hint">{t('apps.defaultKnowledgeBasesHint')}</span>
            </div>
          )}

          <div className="apps__actions">
            <button type="button" className="apps__cancel" onClick={closeForm}>
              {t('apps.cancel')}
            </button>
            <button type="submit" className="apps__submit" disabled={saving}>
              {editing
                ? saving
                  ? t('apps.savingEdit')
                  : t('apps.saveEdit')
                : saving
                  ? t('apps.saving')
                  : t('apps.save')}
            </button>
          </div>
        </form>
      )}

      {/* 成本分析(有應用才顯示;編輯表單展開時收起,避免頁面過長) */}
      {!form && items.length > 0 && !costQuery.error && (
        <AppsCostPanel daily={daily} names={appNames} days={30} />
      )}

      {/* 搜尋 / 篩選列(有資料才顯示) */}
      {!form && items.length > 0 && (
        <div className="apps__toolbar">
          <input
            className="apps__search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('apps.searchPlaceholder')}
            aria-label={t('apps.searchPlaceholder')}
          />
          <label className="apps__filter">
            <span className="visually-hidden">{t('apps.filterPlatform')}</span>
            <select
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value as Platform | 'all')}
            >
              <option value="all">{t('apps.filterAll')}</option>
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {t(p.labelKey)}
                </option>
              ))}
            </select>
          </label>
          <div className="apps__filter apps__filter--genre">
            <IconSelect
              value={genreFilter}
              options={[
                { value: 'all', label: t('apps.filterAllGenres') },
                ...genreOptions(t),
              ]}
              onChange={(v) => setGenreFilter(v as Genre | 'all')}
              ariaLabel={t('apps.filterGenre')}
            />
          </div>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="apps__grid" aria-hidden="true">
          <div className="apps__card apps__card--skeleton" />
          <div className="apps__card apps__card--skeleton" />
          <div className="apps__card apps__card--skeleton" />
        </div>
      ) : error ? (
        <p className="listpage__error" role="alert">
          {t('page.loadError')}
        </p>
      ) : items.length === 0 ? (
        <div className="listpage__empty">
          <p>{t('page.apps.empty')}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="listpage__empty">
          <p>{t('apps.noMatch')}</p>
        </div>
      ) : (
        <ul className="apps__grid">
          {filtered.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              stats={cardStats.get(app.id)}
              busy={busyId === app.id}
              onEdit={() => openEdit(app)}
              onDelete={() => void onDelete(app)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface CardStats {
  spendUsd: number;
  runs: number;
  passRate: number | null;
  spark: number[];
}

interface AppCardProps {
  app: AppRecord;
  stats?: CardStats;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function AppCard({ app, stats, busy, onEdit, onDelete }: AppCardProps) {
  const { t } = useI18n();
  const hasArtifact = Boolean(app.artifactId) || app.platform === 'web';
  const secondary = (app.secondaryGenres ?? []).filter((g) => g !== app.genre);
  const buildCount = app.builds?.length ?? (app.artifactId ? 1 : 0);

  return (
    <li className={`apps__card${busy ? ' apps__card--busy' : ''}`}>
      <Link to={`/apps/${encodeURIComponent(app.id)}`} className="apps__card-top apps__card-link">
        <div className="apps__thumb">
          {app.iconUrl ? (
            <img src={app.iconUrl} alt={`${app.name} ${t('apps.iconAlt')}`} loading="lazy" />
          ) : (
            <span className="apps__thumb-fallback" aria-hidden="true">
              {app.name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <div className="apps__card-head">
          <span className="apps__card-name" title={app.name}>
            {app.name}
          </span>
          <div className="apps__badges">
            <span className={`apps__platform apps__platform--${app.platform}`}>
              {t(`platform.${app.platform}` as MessageKey)}
            </span>
            {app.genre && (
              <span className="apps__genre" title={t(genreLabelKey(app.genre))}>
                <GenreIcon genre={app.genre} size={13} />
                {t(genreLabelKey(app.genre))}
              </span>
            )}
            {/* 次要類型收成「+N」(滑過看全部),每張卡片標頭一樣高、下方資訊才對得齊。 */}
            {secondary.length > 0 && (
              <span
                className="apps__genre apps__genre--secondary apps__genre--more"
                title={secondary.map((g) => t(genreLabelKey(g))).join('、')}
                aria-label={`${t('apps.secondaryGenres')}:${secondary.map((g) => t(genreLabelKey(g))).join('、')}`}
              >
                +{secondary.length}
              </span>
            )}
          </div>
        </div>
      </Link>

      <dl className="apps__meta">
        <div className="apps__meta-row">
          <dt>{t('apps.version')}</dt>
          <dd className={app.version ? 'apps__mono' : 'apps__muted'}>
            {app.version || t('apps.versionNone')}
            {/* 多版本:顯示保留了幾個安裝檔(詳細在工作區「版本」分頁) */}
            {buildCount > 1 && (
              <span className="apps__builds">
                {t('apps.buildsCount').replace('{n}', String(buildCount))}
              </span>
            )}
          </dd>
        </div>
        <div className="apps__meta-row">
          <dt>{t('apps.identifier')}</dt>
          <dd className={app.identifier ? 'apps__mono' : 'apps__muted'}>
            {app.identifier || t('apps.identifierNone')}
          </dd>
        </div>
        <div className="apps__meta-row">
          <dt>{t('apps.artifact')}</dt>
          <dd>
            <span
              className={`apps__dot ${
                hasArtifact ? 'apps__dot--ok' : 'apps__dot--warn'
              }`}
              aria-hidden="true"
            />
            {hasArtifact ? t('apps.artifactReady') : t('apps.artifactMissing')}
          </dd>
        </div>
        <div className="apps__meta-row">
          <dt>{t('apps.createdAt')}</dt>
          <dd>{new Date(app.createdAt).toLocaleDateString()}</dd>
        </div>
      </dl>

      {/* 近 30 天指標 + 花費走勢(走勢只回答漲跌,精確數字看左邊的金額) */}
      <div className="apps__kpis">
        <div className="apps__kpi">
          <b>{stats ? stats.runs : '—'}</b>
          <span>{t('apps.kpiRuns')}</span>
        </div>
        <div className="apps__kpi">
          <b>
            {stats && stats.passRate !== null ? `${stats.passRate}%` : '—'}
          </b>
          <span title={t('apps.kpiPassRateHint')}>{t('apps.kpiPassRate')}</span>
        </div>
        <div className="apps__kpi">
          <b>{stats ? `$${stats.spendUsd.toFixed(2)}` : '—'}</b>
          <span>{t('apps.kpiSpend')}</span>
        </div>
        {/* 走勢圖自己一列、撐滿卡片寬度 —— 擠在數字旁邊會把三個標籤壓成「測…」 */}
        <div className="apps__kpi-spark">
          <Sparkline
            fluid
            values={stats?.spark ?? []}
            width={240}
            height={28}
            format={(v) => `$${v.toFixed(2)}`}
            ariaLabel={`${app.name} ${t('apps.costTrend')}`}
          />
        </div>
      </div>

      <p className={`apps__notes ${app.notes ? '' : 'apps__muted'}`}>
        {app.notes || t('apps.notesEmpty')}
      </p>

      <div className="apps__card-footer">
      <Link
        to={`/apps/${encodeURIComponent(app.id)}`}
        className="apps__enter-btn"
      >
        {t('workspace.enter')} →
      </Link>

      <div className="apps__card-actions">
        <button type="button" className="apps__card-btn" onClick={onEdit} disabled={busy}>
          {t('apps.edit')}
        </button>
        <button
          type="button"
          className="apps__card-btn apps__card-btn--danger"
          onClick={onDelete}
          disabled={busy}
        >
          {t('apps.delete')}
        </button>
      </div>
      </div>
    </li>
  );
}
