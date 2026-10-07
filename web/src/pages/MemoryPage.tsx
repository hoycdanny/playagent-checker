import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiGet, type ListResponse } from '../api/client.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import GenreIcon, { genreLabelKey, type Genre } from '../components/GenreIcon.tsx';
import MemoryPanel from '../components/memory/MemoryPanel.tsx';
import './ListPage.css';
import './MemoryPage.css';

interface AppRecord { id: string; name: string; genre?: Genre; platform?: string }

/**
 * 記憶地圖(獨立頁)—— 只負責「選哪個 App」,內容交給 MemoryPanel。
 * 同一個面板也嵌在應用工作區的記憶分頁,兩邊行為一致。
 */
export default function MemoryPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [appId, setAppIdState] = useState('');

  // 選擇的 App 同步到網址(?app=),讓其他頁的連結可直接帶到對應 App。
  function setAppId(id: string) {
    setAppIdState(id);
    const next = new URLSearchParams(searchParams);
    if (id) next.set('app', id); else next.delete('app');
    setSearchParams(next, { replace: true });
  }

  useEffect(() => {
    apiGet<ListResponse<AppRecord>>('/apps')
      .then((r) => {
        setApps(r.items);
        const wanted = searchParams.get('app');
        const pick = r.items.find((a) => a.id === wanted) ?? r.items[0];
        if (pick) setAppIdState(pick.id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedApp = apps.find((a) => a.id === appId);

  return (
    <section className="listpage listpage--wide memory">
      <header className="listpage__header">
        <h1 className="listpage__title">{t('page.memory.title')}</h1>
        <div className="memory__app-picker">
          {selectedApp?.genre && (
            <span className="memory__app-genre" aria-label={t(genreLabelKey(selectedApp.genre))}>
              <GenreIcon genre={selectedApp.genre} size={18} />
            </span>
          )}
          <label className="memory__app">
            <span className="visually-hidden">{t('memory.selectApp')}</span>
            <select value={appId} onChange={(e) => setAppId(e.target.value)}>
              {apps.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {appId
        ? <MemoryPanel appId={appId} />
        : <div className="listpage__empty"><p>{t('page.memory.empty')}</p></div>}
    </section>
  );
}
