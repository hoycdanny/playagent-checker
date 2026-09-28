import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom 在未配置 origin 時不提供 localStorage(sessionStorage 有);
// 補一個最小記憶體實作,讓依賴 localStorage 的程式與測試在此環境可運行。
if (typeof window.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, 'localStorage', {
    value: memoryStorage,
    configurable: true,
  });
}

// jsdom 未實作 matchMedia;提供最小 polyfill 讓響應式邏輯在測試環境可運行。
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}
