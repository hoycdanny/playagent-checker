import { useMemo, useState } from 'react';

/**
 * 客戶端分頁(Req 15.5)—— 清單資料量增長時,單次渲染量不隨總量無上限成長。
 * 以「顯示更多」漸進揭露,避免一次把數百列全數掛上 DOM 拖垮渲染。
 *
 * 說明:目前 API 回全量清單,此為渲染層的量控;當資料規模進一步成長,
 * 可在不改 UI 的前提下把 loadMore 換成 API 游標分頁(介面不變)。
 */
export interface PagedList<T> {
  /** 目前可見(已揭露)的項目。 */
  visible: T[];
  /** 是否還有未揭露的項目。 */
  hasMore: boolean;
  /** 已揭露數量。 */
  shownCount: number;
  /** 總數。 */
  total: number;
  /** 再揭露一頁。 */
  loadMore: () => void;
}

export function usePagedList<T>(items: T[], pageSize = 25): PagedList<T> {
  const [limit, setLimit] = useState(pageSize);

  return useMemo(() => {
    const total = items.length;
    const shown = Math.min(limit, total);
    return {
      visible: items.slice(0, shown),
      hasMore: shown < total,
      shownCount: shown,
      total,
      loadMore: () => setLimit((n) => n + pageSize),
    };
  }, [items, limit, pageSize]);
}
