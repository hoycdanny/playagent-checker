import { apiGet, apiPost, apiPut } from './client.ts';
import { gestureBody, type PickPoint } from '../components/tasks/LivePlayer.tsx';

/**
 * 接管模式:測試人員自己操作被測畫面,AI 退到旁邊。
 *
 * 和既有「指定點擊」的差別:指定點擊是選位置 → 再按送出 → 等 runner 下一步才執行
 * (實測 5~10 秒,因為那個迴圈被 VLM 綁住)。接管開啟時 runner 不呼叫 VLM,
 * 改成 250ms 輪詢,所以這裡點了就直接送、不用再按一次送出。
 */

export interface TakeoverState {
  enabled: boolean;
  by?: string;
  at?: string;
}

export interface TakeoverScriptAction {
  seq: number;
  kind: string;
  screen?: string;
  point?: { x: number; y: number };
  to?: { x: number; y: number };
  key?: string;
  text?: string;
  ok?: boolean;
}

export interface TakeoverScript {
  jobId: string;
  actions: TakeoverScriptAction[];
  /** 可直接存成測試案例的 YAML(後端產生)。 */
  yaml: string;
  suggestedName: string;
}

export function getTakeover(jobId: string): Promise<TakeoverState> {
  return apiGet<TakeoverState>(`/tasks/${encodeURIComponent(jobId)}/takeover`);
}

export function setTakeover(jobId: string, enabled: boolean): Promise<TakeoverState> {
  return apiPut<TakeoverState>(`/tasks/${encodeURIComponent(jobId)}/takeover`, { enabled });
}

/** 送一個手勢(點一下或拖曳)。runner 會在 250ms 內取用。 */
export function sendTakeoverGesture(jobId: string, p: PickPoint): Promise<{ id: string }> {
  return apiPost<{ id: string }>(`/tasks/${encodeURIComponent(jobId)}/takeover/input`, {
    kind: p.to ? 'drag' : 'tap',
    ...gestureBody(p),
  });
}

/** 送一個按鍵 / 文字 / 返回。 */
export function sendTakeoverAction(
  jobId: string,
  action:
    | { kind: 'key'; key: string; repeat?: number; holdMs?: number }
    | { kind: 'type'; text: string }
    | { kind: 'back' },
): Promise<{ id: string }> {
  return apiPost<{ id: string }>(`/tasks/${encodeURIComponent(jobId)}/takeover/input`, action);
}

/** 接管期間錄到的操作序列 + 可存成案例的 YAML。沒有錄到任何操作時後端回 404。 */
export function getTakeoverScript(jobId: string): Promise<TakeoverScript> {
  return apiGet<TakeoverScript>(`/tasks/${encodeURIComponent(jobId)}/takeover/script`);
}
