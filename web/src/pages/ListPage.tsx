import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import { apiGet, type ListResponse } from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import './ListPage.css';

interface ListPageProps {
  titleKey: MessageKey;
  emptyKey: MessageKey;
  /** 對應 API 路徑,如 /apps、/tasks。 */
  endpoint: string;
  cacheKey: string;
}

/**
 * 通用清單頁骨架:載入時顯示骨架屏(不閃白),空清單顯示空狀態,錯誤顯示錯誤。
 * 階段 2 各功能頁共用此骨架;後續階段各頁再擴充自己的欄位與操作。
 */
export function ListPage({ titleKey, emptyKey, endpoint, cacheKey }: ListPageProps) {
  const { t } = useI18n();
  const { data, loading, error } = useQuery<ListResponse>(cacheKey, () =>
    apiGet<ListResponse>(endpoint),
  );

  const items = data?.items ?? [];

  return (
    <section className="listpage">
      <header className="listpage__header">
        <h1 className="listpage__title">{t(titleKey)}</h1>
      </header>

      {loading && items.length === 0 ? (
        <div className="listpage__skeleton" aria-hidden="true">
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
        </div>
      ) : error ? (
        <p className="listpage__error" role="alert">
          {t('page.loadError')}
        </p>
      ) : items.length === 0 ? (
        <div className="listpage__empty">
          <p>{t(emptyKey)}</p>
        </div>
      ) : (
        <ul className="listpage__list">
          {items.map((item, i) => (
            <li key={i} className="listpage__item">
              {item.key}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
