import { useCallback, useEffect, useRef, useState } from 'react';

/** 極簡的 stale-while-revalidate 快取(跨元件共享,對齊 Req 15.4)。 */
const cache = new Map<string, unknown>();

export interface QueryState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * useQuery —— 有快取先顯示快取(不閃 loading),背景重新驗證。
 * key 相同者共用快取值,達成回訪即時呈現。
 */
export function useQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
): QueryState<T> {
  const [data, setData] = useState<T | undefined>(
    () => cache.get(key) as T | undefined,
  );
  const [loading, setLoading] = useState<boolean>(!cache.has(key));
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(() => {
    let cancelled = false;
    if (!cache.has(key)) setLoading(true);
    setError(null);
    fetcherRef
      .current()
      .then((result) => {
        if (cancelled) return;
        cache.set(key, result);
        setData(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  useEffect(() => run(), [run]);

  return { data, loading, error, refetch: () => run() };
}
