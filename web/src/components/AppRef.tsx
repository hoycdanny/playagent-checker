import { useMemo } from 'react';
import { apiGet, type ListResponse } from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import GenreIcon, { genreLabelKey, type Genre } from './GenreIcon.tsx';
import './AppRef.css';

/** 共用的被測應用摘要(各頁做「來自哪個 App」標注用)。 */
export interface AppRef {
  id: string;
  name: string;
  genre?: Genre;
  platform?: string;
}

/**
 * 共用 App 清單 + 查找。以 useQuery('apps') 快取,和其他頁共用,不重複抓取。
 * 回傳 lookup(appId → AppRef)方便各頁把 appId 解析成可顯示的名稱/類型。
 */
export function useAppLookup(): {
  apps: AppRef[];
  lookup: (appId: string | undefined) => AppRef | undefined;
} {
  const { data } = useQuery<ListResponse<AppRef>>('apps', () =>
    apiGet<ListResponse<AppRef>>('/apps'),
  );
  const apps = data?.items ?? [];
  const map = useMemo(() => {
    const m = new Map<string, AppRef>();
    for (const a of apps) m.set(a.id, a);
    return m;
  }, [apps]);
  return {
    apps,
    lookup: (appId) => (appId ? map.get(appId) : undefined),
  };
}

export interface AppBadgeProps {
  /** 已解析的 App(優先);或只給 appId + name 由呼叫端提供。 */
  app?: AppRef;
  /** 找不到 App 時的後備顯示文字(通常是 appId)。 */
  fallbackId?: string;
  size?: number;
  className?: string;
}

/**
 * 「來自哪個 App」標籤:遊戲類型 icon(若有)+ App 名稱。
 * app 未解析到時退回顯示 fallbackId(至少讓使用者看得到歸屬)。
 */
export default function AppBadge({ app, fallbackId, size = 14, className }: AppBadgeProps) {
  const { t } = useI18n();
  const name = app?.name ?? fallbackId ?? '';
  if (!name) return null;
  return (
    <span className={`appref${className ? ` ${className}` : ''}`} title={name}>
      {app?.genre && (
        <span className="appref__icon" aria-label={t(genreLabelKey(app.genre))}>
          <GenreIcon genre={app.genre} size={size} />
        </span>
      )}
      <span className="appref__name">{name}</span>
    </span>
  );
}
