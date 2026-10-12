import { useMemo, useRef, useState } from 'react';
import { apiDelete, apiPost } from '../../api/client.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { outcomeOf, type VerdictInfo } from '../outcome.ts';

export interface AppBuild {
  artifactId: string;
  label: string;
  kind: 'apk' | 'ipa' | 'zip' | 'exe';
  uploadedAt: string;
  notes?: string;
  uploadedBy?: string;
}

interface TaskLike {
  state: string;
  verdict?: VerdictInfo;
  artifactVersion?: string;
}

/** 平台 → 可上傳的檔案類型。Windows 接安裝檔或免安裝壓縮檔。 */
function kindFor(platform: string, filename: string): AppBuild['kind'] {
  if (platform === 'ios') return 'ipa';
  if (platform === 'windows') return filename.toLowerCase().endsWith('.zip') ? 'zip' : 'exe';
  return 'apk';
}
function acceptFor(platform: string): string {
  if (platform === 'ios') return '.ipa';
  if (platform === 'windows') return '.exe,.zip';
  return '.apk,.xapk,.apkm,.apks';
}

// 以測試結論計(與報告封面一致):通過含「通過(有風險)」;受阻不列入通過率。
const PASS = new Set(['pass', 'pass_risk']);
const DECIDED = new Set(['pass', 'pass_risk', 'fail']);

/**
 * BuildsPanel —— 同一個 App 的多個版本(APK/IPA/EXE)。
 *
 * 設計要點:
 * - 「使用中」只有一個,送出任務預設測它;要測舊版就在送出表單選版本。
 * - 每一版列出它自己的測試次數與通過率 —— 這是多版本的主要價值:看得出
 *   新版有沒有比舊版退步。資料來自任務的 artifactVersion(就是產物 id)。
 * - 刪版本只從清單移除;安裝檔只有在沒有任何 App 還留著它時才真的從 S3 刪掉。
 *   歷史報告指向舊版不受影響(報告看的是當時的執行結果,不需要重新安裝)。
 */
export default function BuildsPanel({
  appId,
  platform,
  builds,
  activeArtifactId,
  tasks,
  onChanged,
}: {
  appId: string;
  platform: string;
  builds: AppBuild[];
  activeArtifactId?: string;
  tasks: TaskLike[];
  onChanged: (nextApp: unknown) => void;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [pct, setPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每一版的執行統計:次數與通過率(只算 pass/fail,error/取消不列入通過率)。
  const statsByBuild = useMemo(() => {
    const m = new Map<string, { runs: number; decided: number; passed: number }>();
    for (const x of tasks) {
      const key = x.artifactVersion;
      if (!key) continue;
      const cur = m.get(key) ?? { runs: 0, decided: 0, passed: 0 };
      cur.runs += 1;
      const o = outcomeOf(x);
      if (DECIDED.has(o)) {
        cur.decided += 1;
        if (PASS.has(o)) cur.passed += 1;
      }
      m.set(key, cur);
    }
    return m;
  }, [tasks]);

  async function onUpload(file: File) {
    setError(null);
    setBusy(true);
    setPct(0);
    try {
      const kind = kindFor(platform, file.name);
      // 先要一個 presigned PUT(位元組直傳 S3,不經 Lambda),再把版本登記到 App。
      const target = await apiPost<{ url: string; artifactId: string }>('/uploads', { kind });
      await uploadToS3(target.url, file, setPct);
      const next = await apiPost(`/apps/${encodeURIComponent(appId)}/builds`, {
        artifactId: target.artifactId,
        label: label.trim() || file.name,
        kind,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      setLabel('');
      setNotes('');
      setPct(null);
      if (fileRef.current) fileRef.current.value = '';
      onChanged(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPct(null);
    } finally {
      setBusy(false);
    }
  }

  async function onActivate(artifactId: string) {
    setError(null);
    setBusy(true);
    try {
      const next = await apiPost(`/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(artifactId)}/activate`, {});
      onChanged(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(b: AppBuild) {
    if (!window.confirm(t('workspace.buildDeleteConfirm').replace('{v}', b.label))) return;
    setError(null);
    setBusy(true);
    try {
      const next = await apiDelete(`/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(b.artifactId)}`);
      onChanged(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws__builds">
      <p className="ws__muted">{t('workspace.buildsDesc')}</p>

      <div className="ws__build-upload">
        <label className="ws__field">
          <span className="ws__label">{t('workspace.buildLabel')}</span>
          <input
            value={label}
            placeholder={t('workspace.buildLabelHint')}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label className="ws__field">
          <span className="ws__label">{t('workspace.buildNotes')}</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <label className="ws__upload">
          <input
            ref={fileRef}
            type="file"
            className="visually-hidden"
            accept={acceptFor(platform)}
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onUpload(f);
            }}
          />
          <span className="ws__primary ws__link-btn">{t('workspace.buildUpload')}</span>
        </label>
        {pct !== null && <span className="ws__muted" role="status">{t('apps.uploading')} {pct}%</span>}
      </div>

      {error && <p className="listpage__error" role="alert">{error}</p>}

      {builds.length === 0 ? (
        <div className="listpage__empty"><p>{t('workspace.buildsEmpty')}</p></div>
      ) : (
        <ul className="ws__build-list">
          {builds.map((b) => {
            const s = statsByBuild.get(b.artifactId);
            const rate = s && s.decided > 0 ? Math.round((s.passed / s.decided) * 100) : null;
            const active = b.artifactId === activeArtifactId;
            return (
              <li key={b.artifactId} className={`ws__build${active ? ' ws__build--active' : ''}`}>
                <div className="ws__build-main">
                  <span className="ws__build-label">{b.label}</span>
                  {active && <span className="ws__build-badge">{t('workspace.buildActive')}</span>}
                  <span className="ws__build-kind">{b.kind.toUpperCase()}</span>
                  {b.notes && <span className="ws__muted">{b.notes}</span>}
                </div>
                <div className="ws__build-stats">
                  <span className="ws__muted">
                    {t('workspace.buildRuns').replace('{n}', String(s?.runs ?? 0))}
                  </span>
                  {rate !== null && (
                    <span className={`ws__build-rate ${rate >= 80 ? 'is-good' : rate >= 50 ? 'is-mid' : 'is-bad'}`}>
                      {rate}% {t('reports.stat.passRate')}
                    </span>
                  )}
                  {b.uploadedAt && (
                    <time className="ws__muted" dateTime={b.uploadedAt}>
                      {new Date(b.uploadedAt).toLocaleDateString()}
                    </time>
                  )}
                </div>
                <div className="ws__build-actions">
                  {!active && (
                    <button type="button" className="ws__secondary" disabled={busy} onClick={() => void onActivate(b.artifactId)}>
                      {t('workspace.buildActivate')}
                    </button>
                  )}
                  <button type="button" className="ws__remove" disabled={busy} onClick={() => void onRemove(b)}>
                    {t('workspace.buildDelete')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** 直傳 S3(XHR 才拿得到上傳進度;fetch 沒有 upload progress)。 */
function uploadToS3(url: string, file: File, onPct: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`上傳失敗 ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('上傳失敗'));
    xhr.send(file);
  });
}
