import { useEffect, useRef, useState } from 'react';
import { getConfig } from '../config.ts';
import { loadTokens } from '../auth/tokenStore.ts';
import { apiGet } from './client.ts';

export interface Step {
  index: number;
  action?: string;
  url?: string;
  httpStatus?: number;
  observedTitle?: string;
  screenshot?: string;
  // devicefarm/emulator runner 每步的欄位:畫面名、AI 思考、截圖(API 已附 presigned URL)。
  screen?: string;
  thinking?: string;
  screenshotUrl?: string;
  annotatedUrl?: string;
  x?: number;
  y?: number;
  [key: string]: unknown;
}

/** 執行實際生效的一個 seat 的模型 + 單價(來自後端 config 快照)。 */
export interface MetaSeat {
  seat: string;
  modelId: string;
  channel?: string;
  inputPerM: number;
  outputPerM: number;
  estimated?: boolean;
}

/** 任務詳情 metadata:套用情境、使用模型、花費(後端彙整 job/config/report)。 */
export interface TaskMeta {
  task?: string;
  knowledgeBaseIds: string[];
  vlmModel?: string;
  /** 實際執行的真機機型(Device Farm)。 */
  deviceModel?: string;
  seats: MetaSeat[];
  tokens?: { input: number; output: number };
  budgetUsd?: number;
  billableSpendUsd?: number;
  spendEstimated?: boolean;
  /** 完整測試腳本(案例 task 原文)。 */
  script?: string;
  caseName?: string;
  caseVersion?: string;
  maxSteps?: number;
}

/** Device Farm 啟動進度(runner 寫進 status.json)。 */
export type BootPhase = 'download' | 'upload' | 'device' | 'connect' | 'run';
export interface BootProgress {
  runnerAt?: string;
  phase?: BootPhase;
  at?: Partial<Record<BootPhase, string>>;
  deviceStatus?: string;
  deviceModel?: string;
  sizeMB?: number;
  /** Device Farm 連線段:第幾段、這段幾點到時間上限(單段 = 收尾;長時 = 換新連線)。 */
  session?: { segment: number; maxSegments: number; startedAt: string; wrapAt: string; wrapMin: number };
}

export interface JobDetail {
  job: { jobId: string; backend: string; locality: string; appId: string; caseId: string; createdAt?: string } | null;
  state: string;
  message?: string;
  boot?: BootProgress;
  updatedAt?: string;
  steps: Step[];
  meta?: TaskMeta;
}

export interface JobStream {
  state: string;
  message?: string;
  steps: Step[];
  meta?: TaskMeta;
  /** 任務所屬應用 id(來自 job.json;供即時指令 / 應用記憶連結)。 */
  appId?: string;
  /** 後端(devicefarm / web …)與送出時間。 */
  backend?: string;
  createdAt?: string;
  /** 啟動進度 + 狀態最後更新時間(終局時間用)。 */
  boot?: BootProgress;
  updatedAt?: string;
  connected: boolean;
  loading: boolean;
}

const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);

/**
 * 訂閱一個任務的即時串流(Req 5.4/5.5):
 * 1. 先以 API 拉一次詳情(含目前所有 steps)—— 這也是重連後的「補讀」來源。
 * 2. 開 WebSocket(?token=idToken),subscribe 該 job,收 step/status 推送即時合併。
 * 3. WS 中斷自動重連,重連前先再拉一次 API 補回中斷期間遺漏的 steps。
 * 前端從不假設持久長連線;S3(經 API)是補讀真相源。
 */
export function useJobStream(jobId: string | null): JobStream {
  const [state, setState] = useState<string>('queued');
  const [message, setMessage] = useState<string | undefined>();
  const [steps, setSteps] = useState<Step[]>([]);
  const [meta, setMeta] = useState<TaskMeta | undefined>();
  const [appId, setAppId] = useState<string | undefined>();
  const [backend, setBackend] = useState<string | undefined>();
  const [createdAt, setCreatedAt] = useState<string | undefined>();
  const [boot, setBoot] = useState<BootProgress | undefined>();
  const [updatedAt, setUpdatedAt] = useState<string | undefined>();
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    if (!jobId) return;
    closedRef.current = false;
    const cfg = getConfig();

    // 合併 steps(以 index 去重,保序)
    const mergeStep = (incoming: Step) => {
      setSteps((prev) => {
        if (prev.some((s) => s.index === incoming.index)) return prev;
        return [...prev, incoming].sort((a, b) => a.index - b.index);
      });
    };

    // API 補讀:拉詳情覆蓋 state/message,合併所有 steps。
    const replay = async () => {
      try {
        const detail = await apiGet<JobDetail>(`/tasks/${jobId}`);
        setState(detail.state);
        setMessage(detail.message);
        if (detail.meta) setMeta(detail.meta);
        if (detail.job?.appId) setAppId(detail.job.appId);
        if (detail.job?.backend) setBackend(detail.job.backend);
        if (detail.job?.createdAt) setCreatedAt(detail.job.createdAt);
        if (detail.boot) setBoot(detail.boot);
        if (detail.updatedAt) setUpdatedAt(detail.updatedAt);
        setSteps((prev) => {
          const byIndex = new Map(prev.map((s) => [s.index, s]));
          for (const s of detail.steps) byIndex.set(s.index, s);
          return [...byIndex.values()].sort((a, b) => a.index - b.index);
        });
      } catch {
        /* 忽略,WS 仍可能帶來更新 */
      } finally {
        setLoading(false);
      }
    };

    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    // WS 推來的 step 是 S3 原始 JSON(只有 screenshotKey,沒有 presigned URL)→ 圖片要重整才出現。
    // 收到新 step 後(去抖)補讀一次 API,拿到附 presigned URL 的版本覆蓋。
    let enrichTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleEnrich = () => {
      if (enrichTimer) clearTimeout(enrichTimer);
      enrichTimer = setTimeout(() => { if (!closedRef.current) void replay(); }, 700);
    };

    const connect = () => {
      const tokens = loadTokens();
      if (!cfg.wsUrl || !tokens) {
        setLoading(false);
        return;
      }
      const ws = new WebSocket(`${cfg.wsUrl}?token=${encodeURIComponent(tokens.idToken)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ action: 'subscribe', jobId }));
        // 連上後補讀一次,補回連線建立前的步驟(Req 5.4)
        void replay();
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string;
            data: unknown;
          };
          if (msg.type === 'step') {
            const st = msg.data as Step;
            mergeStep(st);
            if (!st.screenshotUrl && !st.annotatedUrl) scheduleEnrich();
          }
          if (msg.type === 'status') {
            const d = msg.data as { state: string; message?: string; boot?: BootProgress; updatedAt?: string };
            setState(d.state);
            setMessage(d.message);
            if (d.boot) setBoot(d.boot);
            if (d.updatedAt) setUpdatedAt(d.updatedAt);
          }
        } catch {
          /* 忽略非 JSON */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (closedRef.current) return;
        // 若任務尚未終局,重連(重連 onopen 會再補讀)
        if (!TERMINAL.has(stateRef.current)) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
      ws.onerror = () => ws.close();
    };

    // 先補讀一次(即使 WS 尚未連上也能顯示現況),再連線。
    void replay().then(connect);
    // 保底輪詢:WS 沒連上(或被代理擋掉)時每 5 秒補讀一次,任務終局即停止。
    const fallbackTimer = setInterval(() => {
      if (closedRef.current || TERMINAL.has(stateRef.current)) return;
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      void replay();
    }, 5000);

    return () => {
      closedRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (enrichTimer) clearTimeout(enrichTimer);
      clearInterval(fallbackTimer);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // 用 ref 讓 onclose 讀到最新 state,避免閉包過期
  const stateRef = useRef(state);
  stateRef.current = state;

  return { state, message, steps, meta, appId, backend, createdAt, boot, updatedAt, connected, loading };
}
