import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet } from '../../api/client.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import type { AppBuild } from './BuildsPanel.tsx';

export interface SnapshotInfo {
  name: string;
  artifactVersion: string;
  androidVersion: string;
  arch: string;
  display: string;
  sizeBytes: number;
  updatedAt: string;
}

/**
 * SnapshotsPanel —— Android 容器的 per-app 快照。
 *
 * 快照是一份已安裝、而且走過登入／新手教學的 `/data`。主機端在任務 pass 時自動建立
 * (見 engine/emulator/run.sh),這裡只讓使用者看得到、刪得掉。
 *
 * 為什麼要能刪:快照會把「當時的狀態」固定下來。遊戲改版讓舊存檔不相容、帳號被停用、
 * 或者就是想從乾淨狀態重測時,刪掉是唯一的辦法 —— 下一次任務就會走完整安裝流程,
 * 並在 pass 後重新建一份。
 *
 * 五個維度(App、產物版本、Android 版本、架構、解析度)都列出來,因為任一個不符
 * 主機就會忽略這份快照改走乾淨安裝。使用者看到「有快照卻還是重裝了」時,對照這幾欄
 * 才找得出是哪一維不符。
 */
export default function SnapshotsPanel({ appId, builds }: { appId: string; builds: AppBuild[] }) {
  const { t } = useI18n();
  const [items, setItems] = useState<SnapshotInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiGet<{ items: SnapshotInfo[] }>(`/apps/${encodeURIComponent(appId)}/snapshots`);
      setItems(res.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRemove(s: SnapshotInfo) {
    if (!window.confirm(t('workspace.snapDeleteConfirm'))) return;
    setError(null);
    setBusy(true);
    try {
      const res = await apiDelete<{ items: SnapshotInfo[] }>(
        `/apps/${encodeURIComponent(appId)}/snapshots?name=${encodeURIComponent(s.name)}`,
      );
      setItems(res.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // 產物 id(art-…)不好讀,有對應的版本就顯示使用者自己取的標籤。
  const labelOf = (artifactVersion: string): string =>
    builds.find((b) => b.artifactId === artifactVersion)?.label ?? artifactVersion;

  return (
    <section className="ws__snaps">
      <h3 className="ws__snaps-title">{t('workspace.snapshots')}</h3>
      <p className="ws__muted">{t('workspace.snapshotsDesc')}</p>

      {error && <p className="listpage__error" role="alert">{error}</p>}

      {items === null ? (
        <p className="ws__muted" role="status">{t('workspace.snapshotsLoading')}</p>
      ) : items.length === 0 ? (
        <div className="listpage__empty"><p>{t('workspace.snapshotsEmpty')}</p></div>
      ) : (
        <ul className="ws__snap-list">
          {items.map((s) => (
            <li key={s.name} className="ws__snap">
              <div className="ws__snap-main">
                <span className="ws__snap-build">{labelOf(s.artifactVersion)}</span>
                <span className="ws__muted">
                  Android {s.androidVersion} · {s.arch} · {s.display}
                </span>
              </div>
              <div className="ws__snap-meta">
                <span className="ws__muted">{mb(s.sizeBytes)}</span>
                {s.updatedAt && (
                  <time className="ws__muted" dateTime={s.updatedAt}>
                    {new Date(s.updatedAt).toLocaleString()}
                  </time>
                )}
              </div>
              <button type="button" className="ws__remove" disabled={busy} onClick={() => void onRemove(s)}>
                {t('workspace.snapDelete')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 快照是一百多 MB 的量級,用 MB 顯示剛好;到 GB 才換單位。 */
function mb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const m = bytes / 1024 / 1024;
  return m >= 1024 ? `${(m / 1024).toFixed(1)} GB` : `${Math.round(m)} MB`;
}
