import { useEffect, useState } from 'react';

/** 即時畫面聲音設定(靜音 / 音量),記在 localStorage,主頁與彈出視窗共用。 */
const KEY = 'pa.liveSound';

interface Sound { on: boolean; volume: number }

function read(): Sound {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Sound>;
    return { on: v.on === true, volume: typeof v.volume === 'number' ? Math.min(1, Math.max(0, v.volume)) : 0.8 };
  } catch {
    return { on: false, volume: 0.8 };
  }
}

export function useLiveSound() {
  const [s, setS] = useState<Sound>(read);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }, [s]);
  // 另一個視窗改了設定 → 同步。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setS(read()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return {
    on: s.on,
    volume: s.volume,
    toggle: () => setS((p) => ({ ...p, on: !p.on, volume: !p.on && p.volume === 0 ? 0.8 : p.volume })),
    setVolume: (v: number) => setS({ on: v > 0, volume: v }),
  };
}
