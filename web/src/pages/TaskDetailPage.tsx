import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useJobStream } from '../api/useJobStream.ts';
import { apiGet, apiPost, type ListResponse } from '../api/client.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import { OperatorChat } from '../components/tasks/OperatorChat.tsx';
import { ScriptPanel } from '../components/tasks/ScriptPanel.tsx';
import { TaskInfoStrip } from '../components/tasks/TaskInfoStrip.tsx';
import { BootTimeline } from '../components/tasks/BootTimeline.tsx';
import { InfoIcon } from '../components/tasks/InfoIcon.tsx';
import { LiveScreen } from '../components/tasks/LiveScreen.tsx';
import { gestureBody, type PickPoint } from '../components/tasks/LivePlayer.tsx';
import { getTakeover, sendTakeoverGesture, setTakeover as setTakeoverApi } from '../api/takeover.ts';
import { TakeoverScriptSave } from '../components/tasks/TakeoverScriptSave.tsx';
import { StepSound } from '../components/tasks/StepSound.tsx';
import { RecordingPlayer, type PlayControl, type SeekRequest } from '../components/tasks/RecordingPlayer.tsx';
import { DeviceLogsPanel, useDeviceLog, type LogChunk } from '../components/tasks/DeviceLogsPanel.tsx';
import { useTraces } from '../components/tasks/AgentLogView.tsx';
import { TaskTimeline } from '../components/tasks/TaskTimeline.tsx';
import { buildTimeline, stepAt } from '../components/tasks/timeline.ts';
import { MomentFeed } from '../components/tasks/MomentFeed.tsx';
import { buildFeed } from '../components/tasks/feed.ts';
import { buildSoundEvents } from '../components/tasks/soundEvents.ts';
import { aspectAt, orientationAt, type Orientation } from '../components/tasks/orientation.ts';
import { TaskAskPanel } from '../components/tasks/TaskAskPanel.tsx';
import { soundInWindow, useAudioLevels } from '../components/tasks/audioLevels.ts';
import { reportLang, type RLang } from '../components/report/reportText.ts';
import { outcomeKey, outcomeOf, outcomeTip } from '../components/outcome.ts';
import { MemoryUsagePanel, StepMemoryChips } from '../components/tasks/MemoryUsagePanel.tsx';
// 數據分析 / Token 用量:原本是「完整日誌」裡的子分頁,現在是這一層的分頁。
import { LiveAnalysisView, analysisHint } from '../components/tasks/LiveAnalysisView.tsx';
import { UsageView, usageHint } from '../components/tasks/UsageView.tsx';
import './ListPage.css';
import './TaskDetailPage.css';

interface KbSummary {
  id: string;
  name: string;
}

/** 把任意值安全轉成可渲染字串;非 string/number/boolean 一律字串化,避免把物件/陣列當
 *  React child 直接渲染而丟出未捕捉例外(長任務的 step 欄位型別偶爾會跑掉,例如模型
 *  輸出異常或 runner 版本差異造成 thinking 不是純字串)。 */
function asText(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** 狀態訊息開頭的「第 N 步:」/「Step N:」與標題列步數重複,去掉。 */
export function stripStepPrefix(msg: string | undefined | null): string {
  return String(msg ?? '').replace(/^\s*(第\s*\d+\s*步|Step\s*\d+)\s*[:：]\s*/i, '');
}

/** 本頁新增文案(zh/en)。 */
const PT = {
  progress: ['第 {n} 步', 'Step {n}'],
  limit: ['上限 {m}', 'of {m}'],
  newestFirst: ['最新在上', 'Newest first'],
  current: ['目前', 'Now'],
  stepCount: ['{n} 步', '{n} steps'],
  booting: ['啟動中…', 'Starting…'],
  bootingDevicefarm: ['真機啟動中…', 'Starting the device…'],
  bootingEmulator: ['Android 容器啟動中…', 'Starting the Android container…'],
  bootingWeb: ['瀏覽器啟動中…', 'Starting the browser…'],
  bootingWindows: ['Windows 主機啟動中…', 'Starting the Windows host…'],
  bootingHint: ['畫面就緒後會自動出現。', 'The screen appears automatically once ready.'],
  bootingHintDevicefarm: ['Device Farm 開機通常需要 3–5 分鐘,畫面就緒後會自動出現。', 'Device Farm usually takes 3–5 minutes; the screen appears automatically.'],
  bootingHintEmulator: ['正在準備 Android 容器(Redroid 雲端主機),畫面就緒後會自動出現。', 'Preparing the Android container (Redroid cloud host); the screen appears automatically.'],
  bootingHintWeb: ['正在啟動雲端瀏覽器,畫面就緒後會自動出現。', 'Starting the cloud browser; the screen appears automatically.'],
  bootingHintWindows: ['Windows 主機(GameLift Streams)首次啟動約需 10–15 分鐘,畫面就緒後會自動出現。', 'The Windows host (GameLift Streams) takes about 10–15 minutes on first start; the screen appears automatically.'],
  replay: ['回放', 'Replay'],
  chat: ['與控制遊戲 Agent 互動', 'Interact with the game-control Agent'],
  goalHint: ['決策 Agent 給這一步的目標', 'Goal set by the Decision Agent for this step'],
  scriptStep: ['腳本 {n}/{m}', 'Script {n}/{m}'],
  effectHint: ['輔助 Agent 判斷這一步的動作有沒有生效', 'Helper Agent verdict on whether this action worked'],
  effectOk: ['✓ 有效', '✓ Worked'],
  effectNone: ['✕ 沒有反應', '✕ No effect'],
  effectOther: ['⚠ 畫面不如預期', '⚠ Unexpected'],
  suspectValue: ['⚠ 疑似讀錯 {k}={v}(前一筆 #{s} = {p})', '⚠ Likely misread {k}={v} (previous #{s} = {p})'],
  betChanged: ['⚠ 投注額變更 {f} → {t}(第 {s} 步起)', '⚠ Bet changed {f} → {t} (since step {s})'],
  segment: ['第 {n} 段連線', 'Session {n}'],
  replayStep: ['回放第 {n} 步(含聲音)', 'Replay step {n} with sound'],
  seekStep: ['在時間軸上跳到這一步', 'Jump to this step on the timeline'],
  tabMoment: ['即時日誌', 'Live log'],
  tabTrace: ['執行軌跡', 'Steps'],
  tabLogs: ['完整日誌', 'Full logs'],
  tabAnalysis: ['數據分析', 'Metrics'],
  tabUsage: ['Token 用量', 'Token usage'],
  tabAsk: ['AI 問答', 'Ask AI'],
  tabAgent: ['與畫面互動', 'Interact with screen'],
  tabScript: ['腳本與執行資訊', 'Script & run info'],
  agentEnded: ['這次測試沒有下過指令。測試進行中可以在這裡告訴控制遊戲的 Agent 該怎麼做,或在畫面上直接點。', 'No instructions were sent in this run. While a test is running you can tell the game-control Agent what to do here, or tap the screen directly.'],
  layout: ['版面', 'Layout'],
  layoutAuto: ['自動', 'Auto'],
  layoutPortrait: ['直向', 'Portrait'],
  layoutLandscape: ['橫向', 'Landscape'],
  layoutHint: ['版面:自動 = 跟著被測 App 的方向切換', 'Layout: Auto follows the app orientation'],
  liveFollow: ['回到即時', 'Back to live'],
  stop: ['停止測試', 'Stop test'],
  stopping: ['停止中…', 'Stopping…'],
  stopConfirm: ['確定要停止這次測試嗎?AI 會在目前這一步結束後停下並釋放裝置,已完成的步驟和截圖都會保留。', 'Stop this test? The AI stops after the current step and releases the device. Completed steps and screenshots are kept.'],
  stopFailed: ['停止失敗:', 'Could not stop: '],
  stopSent: ['已送出停止,AI 會在這一步結束後停下。', 'Stop requested. The AI stops after the current step.'],
} as const;
const pt = (k: keyof typeof PT, lang: RLang) => PT[k][lang === 'zh' ? 0 : 1];

/** 執行軌跡每一步的日期時間(使用者當地時區,依介面語言格式化),例如 2026/10/08 14:30:45。 */
export function stepTime(iso: string, locale: string): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d);
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
}

/** 開機中的標題/說明依執行環境而定(不是每個任務都跑 Device Farm);未知後端用通用文案。 */
const BOOT_SUFFIX: Record<string, 'Devicefarm' | 'Emulator' | 'Web' | 'Windows'> = {
  devicefarm: 'Devicefarm',
  emulator: 'Emulator',
  web: 'Web',
  windows: 'Windows',
};
export function bootText(backend: string | undefined, lang: RLang): { title: string; hint: string } {
  const s = backend ? BOOT_SUFFIX[backend] : undefined;
  return {
    title: pt(s ? (`booting${s}` as const) : 'booting', lang),
    hint: pt(s ? (`bootingHint${s}` as const) : 'bootingHint', lang),
  };
}

/** 右側分頁:AI 互動三個 + 這一刻五個(直向時合成一排)。 */
type PaneTab = 'ask' | 'agent' | 'script' | 'moment' | 'trace' | 'logs' | 'analysis' | 'usage';
type ChatTab = 'ask' | 'agent' | 'script';
type FeedTab = 'moment' | 'trace' | 'logs' | 'analysis' | 'usage';
const CHAT_TABS: readonly ChatTab[] = ['ask', 'agent', 'script'];
/**
 * 右邊框的分頁順序:即時日誌 · 完整日誌 · 執行軌跡 · 數據分析 · Token 用量 · AI 問答 ·
 * 腳本與執行資訊(· 直向再加與 Agent 互動)。
 * 數據分析與 Token 用量原本埋在「完整日誌」裡當子分頁(要點兩層才看得到),拉上來跟其他
 * 看資料的分頁並排;會問問題的三個(AI 問答 / 與畫面互動 / 腳本)留在後面。
 */
const RIGHT_TABS_LANDSCAPE: readonly PaneTab[] = ['moment', 'logs', 'trace', 'analysis', 'usage', 'ask', 'script'];
const RIGHT_TABS_PORTRAIT: readonly PaneTab[] = [...RIGHT_TABS_LANDSCAPE, 'agent'];
const isChatTab = (k: PaneTab): k is ChatTab => (CHAT_TABS as readonly string[]).includes(k);
const TAB_ICON = { ask: 'sparkle', agent: 'msg', script: 'script', moment: 'pulse', trace: 'list', logs: 'term', analysis: 'chart', usage: 'coin' } as const;
const TAB_TEXT = { ask: 'tabAsk', agent: 'tabAgent', script: 'tabScript', moment: 'tabMoment', trace: 'tabTrace', logs: 'tabLogs', analysis: 'tabAnalysis', usage: 'tabUsage' } as const;

export default function TaskDetailPage() {
  const { t, locale } = useI18n();
  const lang = reportLang(locale);
  const { jobId } = useParams<{ jobId: string }>();
  const { state, verdict, message, steps, meta, appId, backend, createdAt, boot, updatedAt, script, connected, loading } = useJobStream(jobId ?? null);
  // 停止測試:POST /tasks/{id}/cancel(runner 在目前這一步結束後停下並釋放裝置)。
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  async function stopTest() {
    if (!jobId || stopping) return;
    if (!window.confirm(pt('stopConfirm', lang))) return;
    setStopping(true);
    setStopError(null);
    try {
      await apiPost(`/tasks/${encodeURIComponent(jobId)}/cancel`, {});
    } catch (err) {
      setStopError(`${pt('stopFailed', lang)}${err instanceof Error ? err.message : String(err)}`);
      setStopping(false);
    }
  }

  // 知識庫 id → 名稱對照(供資訊列以人類可讀名稱呈現)。
  const [kbNames, setKbNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    apiGet<ListResponse<KbSummary>>('/knowledge-bases')
      .then((r) => setKbNames(new Map(r.items.map((k) => [k.id, k.name]))))
      .catch(() => {});
  }, []);

  // 即時畫面串流:任務執行中(非終局)輪詢 live-frame,拿短效 presigned URL 換 <img>。
  // runner 持續覆寫同一 live 幀;URL 每次不同以繞過快取。任務終局即停止輪詢。
  const TERMINAL_STATES = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);
  const isLive = !TERMINAL_STATES.has(state) && state !== 'queued';
  const [liveFrameUrl, setLiveFrameUrl] = useState<string | null>(null);
  // 測試人員在即時畫面上選的位置(可「直接點這裡」在裝置上執行,或在聊天室加說明一起送)。
  const [pickPoint, setPickPoint] = useState<PickPoint | null>(null);
  // 接管模式:開著時 runner 不呼叫 VLM,點畫面就直接執行(延遲從 5~10 秒降到輪詢間隔)。
  const [takeover, setTakeover] = useState(false);
  // 開關狀態以後端為準:同一個任務可能在別的裝置/分頁被切換過。
  useEffect(() => {
    if (!jobId || !isLive) return;
    let stop = false;
    const read = async () => {
      try { const s = await getTakeover(jobId); if (!stop) setTakeover(s.enabled); } catch { /* 讀不到就維持現狀 */ }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => { stop = true; clearInterval(timer); };
  }, [jobId, isLive]);
  async function toggleTakeover(next: boolean) {
    if (!jobId) return;
    const s = await setTakeoverApi(jobId, next);
    setTakeover(s.enabled);
  }
  async function sendTakeoverPoint(p: PickPoint) {
    if (!jobId) return;
    await sendTakeoverGesture(jobId, p);
  }
  async function sendPoint(p: PickPoint) {
    if (!jobId) return;
    await apiPost(`/tasks/${jobId}/commands`, { ...gestureBody(p), remember: false, ...(latestScreen ? { screen: latestScreen } : {}) });
    setChatRefresh((n) => n + 1);
  }
  const [chatRefresh, setChatRefresh] = useState(0);
  // 中欄 / 右欄分頁。右欄:執行中預設「與 Agent 互動」,結束後預設「AI 問答」(使用者點過就照他選的)。
  useEffect(() => {
    if (!jobId || !isLive) {
      setLiveFrameUrl(null);
      return;
    }
    // 依序抓幀:簽 URL → 背景預載(new Image)→ 載完才換上 <img> → 再抓下一幀。
    // 直接每 250ms 換 src 的話,幀還沒下載完就被下一張取消,畫面會看似凍結(需手動刷新)。
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 截圖幀只是影片段落的備援(web 後端仍以截圖串流為主),約 2fps。
    const MIN_INTERVAL_MS = 500;
    const preload = (url: string) =>
      new Promise<boolean>((resolve) => {
        const img = new Image();
        const tm = setTimeout(() => resolve(false), 8000);
        img.onload = () => { clearTimeout(tm); resolve(true); };
        img.onerror = () => { clearTimeout(tm); resolve(false); };
        img.src = url;
      });
    const loop = async () => {
      const started = Date.now();
      let ok = false;
      try {
        const { url } = await apiGet<{ url: string }>(`/tasks/${jobId}/live-frame`);
        if (url && !cancelled && (await preload(url)) && !cancelled) {
          setLiveFrameUrl(url);
          ok = true;
        }
      } catch {
        /* 幀尚未產生/暫時失敗:保留上一幀,不清空 */
      }
      if (cancelled) return;
      const wait = ok ? Math.max(0, MIN_INTERVAL_MS - (Date.now() - started)) : 1500;
      timer = setTimeout(() => void loop(), wait);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, isLive]);

  // 即時畫面回退:取「最新一張有截圖的步驟」(live 幀尚未產生或任務已結束時顯示)。
  const latestShot = [...steps]
    .reverse()
    .find((s) => s.annotatedUrl || s.screenshotUrl);
  const liveUrl = asText(latestShot?.annotatedUrl) ?? asText(latestShot?.screenshotUrl);
  const latestStep = steps[steps.length - 1];
  // 最新一步的畫面名稱:即時指令「記住」時當作提示的畫面範圍,也顯示在即時畫面下方。
  // 略過回應無法解析的步驟(畫面名只是「畫面 87」這種流水號),取最近一個 AI 真的辨識過的畫面。
  const latestScreen = asText([...steps].reverse().find((s) => s.screen && !s.parseFailed)?.screen);
  // 終局後仍顯示指令紀錄(若本次有下過指令)。
  const hasCommands = steps.some((s) => Array.isArray(s.operatorCommands) && s.operatorCommands.length > 0);
  const showChat = !!jobId && (isLive || hasCommands);
  const stepNo = latestStep ? latestStep.index + 1 : 0;
  // 遊戲音效音量時間軸(Device Farm 真機才有):標出每一步有沒有音效。
  const audioLevels = useAudioLevels(jobId, isLive, backend === 'devicefarm');
  const hasAudio = !!audioLevels && audioLevels.chunks.length > 0;
  // 測試結束後的整場錄影(含聲音)回放;點執行軌跡的「回放」跳到那一步。
  const hasRecording = !isLive && !!audioLevels?.chunks.some((c) => typeof c.url === 'string' && c.dur > 0);
  const [seek, setSeek] = useState<SeekRequest | null>(null);
  const [playingStep, setPlayingStep] = useState<number | null>(null);
  // 音效事件要標上「第幾步 / 哪個畫面」。
  const soundStepRefs = useMemo(
    () => steps
      .filter((s) => typeof s.at === 'string')
      .map((s) => ({ index: s.index, t: Date.parse(s.at as string), ...(s.screen && !s.parseFailed ? { screen: String(s.screen) } : {}) }))
      .filter((m) => Number.isFinite(m.t)),
    [steps],
  );
  const stepMarks = useMemo(
    () => steps.filter((s) => typeof s.at === 'string').map((s) => ({ index: s.index, t: Date.parse(s.at as string) })).filter((m) => Number.isFinite(m.t)),
    [steps],
  );

  // ── 時間軸(像影音剪輯軟體):一個共用播放頭,錄影 / 步驟 / AI 呼叫 / 聲音 / 裝置 log 都跟著它 ──
  const isDevice = backend === 'devicefarm' || backend === 'emulator';
  const logcat = useDeviceLog<LogChunk>(jobId ?? '', 'logcat', isLive, !!jobId && isDevice);
  // 網頁任務:瀏覽器 console(等同 Chrome DevTools 的 Console);與 logcat 同格式、同一條管線。
  const isWeb = backend === 'web';
  const consoleLog = useDeviceLog<LogChunk>(jobId ?? '', 'console', isLive, !!jobId && isWeb);
  // Windows 任務:主機腳本(host.ps1)的下載 / 安裝 / 啟動紀錄。AI 還沒開始就失敗時
  // (例如安裝卡住),步驟與截圖都是空的,只有這份 log 說得出原因。
  const isWindows = backend === 'windows';
  const hostLog = useDeviceLog<LogChunk>(jobId ?? '', 'host', isLive, !!jobId && isWindows);
  const summaryTraces = useTraces(jobId ?? '', isLive, !!jobId, 'summary');
  const [videoDur, setVideoDur] = useState<Record<string, number>>({});
  const onDuration = useCallback((name: string, sec: number) => {
    setVideoDur((d) => (Math.abs((d[name] ?? 0) - sec) < 0.01 ? d : { ...d, [name]: sec }));
  }, []);
  // 執行中:時間軸延伸到現在(每 2 秒更新一次)。
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNowTick(Date.now()), 2000);
    return () => clearInterval(id);
  }, [isLive]);
  const timeline = useMemo(
    () => buildTimeline({
      steps,
      levels: audioLevels,
      logChunks: logcat.items,
      traces: summaryTraces ?? [],
      videoDur,
      ...(isLive ? { now: nowTick } : {}),
    }),
    [steps, audioLevels, logcat.items, summaryTraces, videoDur, isLive, nowTick],
  );
  const chunkStarts = useMemo(() => Object.fromEntries(timeline.chunks.map((c) => [c.name, c.t])), [timeline.chunks]);
  // 播放頭(epoch ms);null = 還沒選(執行中跟著最新一步)。
  const [cursor, setCursor] = useState<number | null>(null);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [playCtl, setPlayCtl] = useState<PlayControl | null>(null);
  const lastSeekAt = useRef(0);
  const seekTo = useCallback((t: number, play = false) => {
    setCursor(t);
    lastSeekAt.current = performance.now();
    if (hasRecording) setSeek((p) => ({ t, n: (p?.n ?? 0) + 1, play }));
  }, [hasRecording]);
  // 錄影播放 / 在播放器上跳轉 → 播放頭跟著走(剛由時間軸跳過去的回報略過,避免被影格對齊拉回)。
  const onVideoTime = useCallback((t: number) => {
    if (performance.now() - lastSeekAt.current < 400) return;
    setCursor(t);
  }, []);
  const cursorStep = cursor === null ? null : (stepAt(timeline, cursor)?.index ?? null);
  // 執行軌跡:播放頭所在的步驟捲到看得到(只捲清單本身)。
  const stepsRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (cursorStep === null) return;
    const list = stepsRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-step-row="${cursorStep}"]`);
    if (list && row) list.scrollTo({ top: Math.max(0, row.offsetTop - list.clientHeight / 3) });
  }, [cursorStep]);
  const cursorShot = cursorStep === null ? undefined : steps.find((s) => s.index === cursorStep);
  const cursorShotUrl = asText(cursorShot?.annotatedUrl) ?? asText(cursorShot?.screenshotUrl);

  // 「這一刻」事件流(步驟 / AI / 記憶 / 腳本 / log / 音效 / 指令)。
  const soundEvents = useMemo(
    () => (isDevice ? buildSoundEvents({ logChunks: logcat.items, levels: audioLevels ?? null, steps: soundStepRefs }) : []),
    [isDevice, logcat.items, audioLevels, soundStepRefs],
  );
  const feedEvents = useMemo(() => buildFeed({ tl: timeline, steps, sounds: soundEvents, lang }), [timeline, steps, soundEvents, lang]);

  // 版面方向:跟著被測 App 目前的方向(播放頭那一步;沒選 = 最新一步),也可以手動固定。
  const [orientPref, setOrientPref] = useState<'auto' | Orientation>(() => {
    try { const v = localStorage.getItem('pa.detailOrient'); return v === 'portrait' || v === 'landscape' ? v : 'auto'; } catch { return 'auto'; }
  });
  useEffect(() => { try { localStorage.setItem('pa.detailOrient', orientPref); } catch { /* 無痕模式 */ } }, [orientPref]);
  const appOrient = orientationAt(steps, cursorStep) ?? 'portrait';
  const orient: Orientation = orientPref === 'auto' ? appOrient : orientPref;
  // 錄影是固定大小(App 轉向會加黑邊):用播放頭那一步的畫面比例把 App 畫面放大填滿。
  const appAspect = aspectAt(steps, cursorStep);
  // 右邊的框:直向 6 個分頁(含與 Agent 互動);橫向 5 個,「與 Agent 互動」單獨在手機畫面下方。
  const merged = orient === 'portrait';
  const rightTabs = merged ? RIGHT_TABS_PORTRAIT : RIGHT_TABS_LANDSCAPE;
  const [panePicked, setPanePicked] = useState<PaneTab | null>(null);
  // 預設分頁:執行中 = 與畫面互動(橫向它固定在手機畫面下方,右邊框就顯示即時日誌);結束後 = 完整日誌。
  const wanted: PaneTab = panePicked ?? (isLive ? 'agent' : 'logs');
  const activePane: PaneTab = rightTabs.includes(wanted) ? wanted : isLive ? 'moment' : 'logs';
  const midTab: FeedTab = isChatTab(activePane) ? 'moment' : activePane;
  const rightTab: ChatTab = isChatTab(activePane) ? activePane : 'ask';
  const pickTab = (k: PaneTab) => setPanePicked(k);
  const tabBar = (tabs: readonly PaneTab[]) => (
    <div className="dstage__tabs" role="tablist">
      {tabs.map((k) => {
        const on = tabs.length === 1 || activePane === k;
        return (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={on}
            className={`dstage__tab${on ? ' is-on' : ''}`}
            onClick={() => pickTab(k)}
          >
            <InfoIcon name={TAB_ICON[k]} size={15} />
            {pt(TAB_TEXT[k], lang)}
            {k === 'trace' && steps.length > 0 && <small> {steps.length}</small>}
            {k === 'agent' && isLive && <span className="dstage__dot" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
  // 在畫面上點了位置:切到「與 Agent 互動」補一句說明再送出。
  // (橫向的「與 Agent 互動」一直在手機畫面下方,不用切。)
  useEffect(() => { if (pickPoint && orient === 'portrait') setPanePicked('agent'); }, [pickPoint, orient]);

  // 手機畫面欄寬 = 畫面高 × App 寬高比(左右不留白),其餘寬度給右邊。
  const phoneRef = useRef<HTMLElement>(null);
  const [phoneH, setPhoneH] = useState(0);
  useEffect(() => {
    const el = phoneRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setPhoneH(el.clientHeight));
    ro.observe(el);
    setPhoneH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  // 版面換方向 / 時間軸出現時列高會變:再量一次(保險,不只靠 ResizeObserver)。
  const hasSteps = steps.length > 0;
  useEffect(() => {
    const el = phoneRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => setPhoneH(el.clientHeight));
    return () => cancelAnimationFrame(id);
  }, [orient, hasSteps]);
  const PHONE_PAD = 20; // .dstage__phone 上下 / 左右 padding 合計
  const phoneW = phoneH > PHONE_PAD && appAspect ? Math.round((phoneH - PHONE_PAD) * appAspect + PHONE_PAD) : null;

  // 與控制遊戲 Agent 互動(橫向在手機畫面下方、直向在右邊框的最後一個分頁)。
  const agentPane = jobId && (showChat || !!pickPoint) ? (
    <OperatorChat
      jobId={jobId}
      isLive={isLive}
      {...(latestScreen ? { currentScreen: latestScreen } : {})}
      {...(appId ? { appId } : {})}
      point={pickPoint}
      onClearPoint={() => setPickPoint(null)}
      refreshKey={chatRefresh}
    />
  ) : (
    <p className="detail__no-steps">{pt('agentEnded', lang)}</p>
  );

  return (
    <section className="listpage detail">
      {/* 標題列(一行):返回 + 標題 + 狀態 + 步數 + 目前動作 + 任務資訊 + 報告 / 連線狀態 */}
      <header className="detail__head">
        <div className="detail__head-row">
          {/* 回到這個任務所屬應用的「測試任務」分頁(不知道應用時退回總任務清單)。 */}
          <Link
            to={appId ? `/apps/${encodeURIComponent(appId)}?tab=tasks` : '/tasks'}
            className="detail__back detail__back--icon"
            aria-label={t('detail.back')}
            title={t('detail.back')}
          >
            <InfoIcon name="back" size={16} />
          </Link>
          <h1 className="detail__title">{t('detail.title')}</h1>
          {/* 測試結論(與報告封面同一個值);沒有結論(執行中 / 舊任務)才顯示執行狀態。 */}
          <span
            className={`detail__pill detail__pill--${outcomeOf({ state, ...(verdict ? { verdict } : {}) })}`}
            title={outcomeTip({ state, ...(verdict ? { verdict } : {}) }, (k) => t(k), lang)}
          >
            {t(outcomeKey(outcomeOf({ state, ...(verdict ? { verdict } : {}) })))}
          </span>
          {verdict && (
            <span className="detail__exec" title={t('outcome.execution')}>
              {t('outcome.execution')}:{t(`state.${state}` as MessageKey)}
            </span>
          )}
          {/* 步數 / 狀態訊息不顯示(時間軸、這一刻已經看得到);只留給讀屏通報狀態變化(Req 11.3)。 */}
          <span className="visually-hidden" role="status" aria-live="polite">
            {t(`state.${state}` as MessageKey)}
            {stepNo > 0 ? ` · ${pt('progress', lang).replace('{n}', String(stepNo))}` : ''}
            {message ? ` — ${stripStepPrefix(message)}` : ''}
          </span>
          <TaskInfoStrip meta={meta} kbNames={kbNames} />
          <span className="detail__head-end">
            {/* 版面:自動跟著被測 App 的直 / 橫向切換;也可以手動固定。 */}
            <label className="detail__orient" title={pt('layoutHint', lang)}>
              <InfoIcon name={orient === 'landscape' ? 'phoneL' : 'phone'} size={14} className="detail__orient-ico" />
              <span className="visually-hidden">{pt('layout', lang)}</span>
              <select value={orientPref} onChange={(e) => setOrientPref(e.target.value as 'auto' | Orientation)}>
                <option value="auto">{pt('layoutAuto', lang)}</option>
                <option value="portrait">{pt('layoutPortrait', lang)}</option>
                <option value="landscape">{pt('layoutLandscape', lang)}</option>
              </select>
            </label>
            {/* 執行中 / 排隊中可停止。 */}
            {jobId && !TERMINAL_STATES.has(state) && (
              <button type="button" className="detail__stop" onClick={() => void stopTest()} disabled={stopping} aria-busy={stopping}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="currentColor" /></svg>
                {stopping ? pt('stopping', lang) : pt('stop', lang)}
              </button>
            )}
            {/* 任務結束後直接進結構化測試報告(判定明細、截圖、修正建議)。 */}
            {jobId && TERMINAL_STATES.has(state) && state !== 'cancelled' && (
              <Link to={`/reports/${jobId}`} className="detail__report-link">
                {t('detail.viewReport')}<InfoIcon name="chevRight" size={14} />
              </Link>
            )}
            {/* 即時連線狀態:只用圖示(滑過 / 讀屏顯示文字) */}
            <span
              className={`detail__conn detail__conn--icon ${connected ? 'detail__conn--on' : 'detail__conn--off'}`}
              role="img"
              aria-label={connected ? t('detail.connected') : t('detail.disconnected')}
              title={connected ? t('detail.connected') : t('detail.disconnected')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <circle cx="12" cy="20" r="1" fill="currentColor" />
                {!connected && <path d="M2 2l20 20" />}
              </svg>
            </span>
          </span>
        </div>
        {stopError && <p className="detail__triage detail__triage--error" role="alert">{stopError}</p>}
        {stopping && !TERMINAL_STATES.has(state) && <p className="detail__stop-note" role="status">{pt('stopSent', lang)}</p>}
        {/* 測試結論的理由(驗收標準;細節在報告的「驗收結論與標準」)。 */}
        {verdict && verdict.status !== 'PASS' && (
          <p className={`detail__triage detail__triage--${verdict.status === 'FAIL' ? 'fail' : 'error'}`}>
            {t('outcome.verdict')}:{verdict.reason[lang] ?? verdict.reason.zh}
          </p>
        )}
        {/* 成因引導(Req 12.3):fail → 被測 App/案例;error → 環境/基礎設施 */}
        {!verdict && state === 'fail' && (
          <p className="detail__triage detail__triage--fail">{t('trend.triageFail')}</p>
        )}
        {state === 'error' && (
          <p className="detail__triage detail__triage--error">{t('trend.triageError')}</p>
        )}
      </header>

      {/*
        主區依被測 App 方向換版面:
        直向:左 = 手機畫面、中 = AI 互動、右(最寬)= 這一刻(log / 記憶 / 過濾);下 = 時間軸(含聲音,不超過 1/4 高)。
        橫向:左 60% = 手機畫面(上)+ AI 互動(下),右 40% = 這一刻;下 = 時間軸(整頁寬)。
        DOM 順序 = 手機 → AI 互動 → 這一刻(鍵盤 Tab 順序與畫面一致)。
      */}
      <div
        className={`dstage dstage--${orient}${merged ? ' dstage--merged' : ''}`}
        {...(phoneW ? { style: { '--phone-w': `${phoneW}px` } as CSSProperties } : {})}
      >
        {/* 手機畫面:執行中顯示即時影片 / 串流幀;結束後播整場錄影;沒有錄影顯示播放頭那一步的截圖。 */}
        <section ref={phoneRef} className="detail__col dstage__phone" aria-label={t('detail.liveView')}>
          {isLive && (liveFrameUrl || latestStep) && <span className="detail__live-badge dstage__badge">{t('detail.liveBadge')}</span>}
          {/* 開機中(還沒有畫面):顯示 Device Farm 開機各階段 */}
          {steps.length === 0 && (
            <BootTimeline
              state={state}
              lang={lang}
              {...(boot ? { boot } : {})}
              {...(createdAt ? { createdAt } : {})}
              {...(updatedAt ? { updatedAt } : {})}
              {...(backend ? { backend } : {})}
            />
          )}
          {isLive && jobId && (liveFrameUrl || liveUrl || latestStep) ? (
            // 即時影片(2 秒分段、30+ fps);聲音開啟時改播含音效段落。點畫面 → 新視窗(雙螢幕)。
            <LiveScreen
              jobId={jobId}
              isLive={isLive}
              fallbackUrl={liveFrameUrl ?? liveUrl ?? null}
              alt={latestScreen ?? t('detail.liveView')}
              lang={lang}
              point={pickPoint}
              onPoint={setPickPoint}
              onSendPoint={sendPoint}
              takeover={takeover}
              onTakeover={toggleTakeover}
              onTakeoverGesture={sendTakeoverPoint}
              {...(audioLevels?.state ? { audioState: audioLevels.state } : {})}
            />
          ) : hasRecording && audioLevels ? (
            <RecordingPlayer
              levels={audioLevels}
              steps={stepMarks}
              lang={lang}
              seek={seek}
              onStep={setPlayingStep}
              starts={chunkStarts}
              onTime={onVideoTime}
              onDuration={onDuration}
              control={playCtl}
              onPlayingChange={setVideoPlaying}
              bare
              aspect={appAspect}
            />
          ) : (cursorShotUrl ?? liveUrl) ? (
            // 沒有錄影:顯示播放頭那一步的截圖(沒選時間 = 最新一步)。
            <figure className="detail__screen">
              <img src={cursorShotUrl ?? liveUrl} alt={asText((cursorShotUrl ? cursorShot : latestShot)?.screen) ?? t('detail.liveView')} />
            </figure>
          ) : isLive || state === 'queued' ? (
            // 開機中還沒有畫面:顯示手機外框 + 目前階段,不要只有一行字。
            <div className="detail__booting" role="status">
              <div className="detail__booting-phone" aria-hidden="true">
                <InfoIcon name={boot?.phase === 'connect' ? 'plug' : boot?.phase === 'upload' ? 'upload' : boot?.phase === 'download' ? 'package' : boot?.phase === 'device' ? 'phone' : 'cloud'} size={30} />
                <span className="detail__booting-ring" />
              </div>
              <p className="detail__booting-text">{message || bootText(backend, lang).title}</p>
              <p className="detail__booting-sub">{bootText(backend, lang).hint}</p>
            </div>
          ) : (
            // 終局且一張截圖都沒有。原本這裡寫「此後端不提供即時畫面」,但四種後端的 runner
            // 都會寫即時幀 —— 真正的原因是這次沒跑到產生畫面那一步,說成後端不支援會把人
            // 導去查錯方向。Windows 另外指向主機 log,那是唯一有線索的地方。
            <div className="detail__no-live">
              <p>{t('detail.noScreens')}</p>
              {isWindows && <p>{t('detail.noScreensHostLog')}</p>}
            </div>
          )}
        </section>

        {/* 橫向:與控制遊戲 Agent 互動(即時指令)單獨在手機畫面下方 */}
        {!merged && (
          <section className="detail__col dstage__chat" aria-label={pt('tabAgent', lang)}>
            {tabBar(['agent'])}
            {agentPane}
          </section>
        )}

        {/* 右邊框的 AI 問答 / 腳本與執行資訊(直向再加與 Agent 互動) */}
        <section className="detail__col dstage__side" aria-label={pt(TAB_TEXT[rightTab], lang)} hidden={!isChatTab(activePane)}>
          {tabBar(rightTabs)}
          {rightTab === 'ask' ? (
            jobId ? (
              <TaskAskPanel
                jobId={jobId}
                lang={lang}
                embedded
                onStep={(n) => { const s = timeline.steps.find((x) => x.index === n); if (s) seekTo(s.t, false); }}
              />
            ) : null
          ) : rightTab === 'agent' ? (
            agentPane
          ) : (
            <div className="dstage__script">
              <BootTimeline
                state={state}
                lang={lang}
                {...(boot ? { boot } : {})}
                {...(createdAt ? { createdAt } : {})}
                {...(updatedAt ? { updatedAt } : {})}
                {...(backend ? { backend } : {})}
                {...(typeof steps[0]?.at === 'string' ? { firstStepAt: steps[0].at as string } : {})}
              />
              <ScriptPanel
                lang={lang}
                live={isLive}
                {...(script ? { progress: script } : {})}
                {...(meta?.script ?? meta?.task ? { script: meta?.script ?? meta?.task } : {})}
                {...(meta?.caseName ? { caseName: meta.caseName } : {})}
                {...(meta?.caseVersion ? { caseVersion: meta.caseVersion } : {})}
              />
            </div>
          )}
        </section>

        {/* 這一刻:播放頭當下的 log / 記憶 / 腳本 / AI(可層層過濾)· 執行軌跡 · 完整日誌 */}
        <section className="detail__col dstage__feed" aria-label={pt(TAB_TEXT[midTab], lang)} hidden={isChatTab(activePane)}>
          {tabBar(rightTabs)}
          {midTab === 'moment' ? (
            <MomentFeed tl={timeline} steps={steps} events={feedEvents} cursor={cursor ?? (isLive && timeline.steps.length ? timeline.end : null)} onSeek={(t) => seekTo(t, false)} lang={lang} />
          ) : midTab === 'logs' ? (
            jobId ? (
              <div className="detail__col--devlogs dstage__logs">
                <DeviceLogsPanel
                  jobId={jobId}
                  isLive={isLive}
                  device={isDevice}
                  browser={isWeb}
                  host={isWindows}
                  levels={audioLevels}
                  steps={soundStepRefs}
                  onSeek={seekTo}
                  cursor={cursor}
                  origin={timeline.origin}
                  {...(isDevice ? { logcat } : {})}
                  {...(isWeb ? { consoleLog } : {})}
                  {...(isWindows ? { hostLog } : {})}
                  cursorStep={cursorStep}
                />
                {/* 【學習 B】接管錄到的手動操作 → 存成可重跑的測試案例。 */}
                <TakeoverScriptSave jobId={jobId} {...(appId ? { appId } : {})} />
              </div>
            ) : null
          ) : midTab === 'analysis' ? (
            // 數據分析:勾選的指標,測試中每 10 秒重算(與測試報告同一套指標)。
            jobId ? (
              <div className="dstage__panel">
                <p className="devlogs__muted">{analysisHint(locale)}</p>
                <LiveAnalysisView jobId={jobId} isLive={isLive} {...(appId ? { appId } : {})} loc={locale} />
              </div>
            ) : null
          ) : midTab === 'usage' ? (
            // Token 用量:每個 Agent 的 token 與估算費用(summaryTraces 外層已讀好,不重讀)。
            <div className="dstage__panel">
              <p className="devlogs__muted">{usageHint(locale)}</p>
              <UsageView
                traces={summaryTraces}
                seats={meta?.seats ?? []}
                {...(meta?.prices ? { prices: meta.prices } : {})}
                loc={locale}
              />
            </div>
          ) : (
          <div className="dstage__trace">
          {loading && steps.length === 0 ? (
            <div className="listpage__skeleton" aria-hidden="true">
              <div className="listpage__skeleton-row" />
            </div>
          ) : steps.length === 0 ? (
            <p className="detail__no-steps">{t('detail.noSteps')}</p>
          ) : (
            <>
            <MemoryUsagePanel steps={steps} lang={lang} />
            <ol ref={stepsRef} className="detail__steps" reversed>
              {[...steps].reverse().map((s, k) => {
                const thumb = asText(s.annotatedUrl) ?? asText(s.screenshotUrl);
                const screenText = asText(s.screen);
                const actionText = asText(s.action);
                const thinkingText = asText(s.thinking);
                const urlText = asText(s.url);
                const titleText = asText(s.observedTitle);
                const opCmds = Array.isArray(s.operatorCommands)
                  ? (s.operatorCommands as Array<{ id?: unknown; text?: unknown }>)
                      .map((c) => asText(c?.text))
                      .filter((x): x is string => !!x)
                  : [];
                return (
                  <li
                    key={s.index}
                    data-step-row={s.index}
                    className={`detail__step ${k === 0 && !hasRecording && cursorStep === null ? 'detail__step--latest' : ''} ${(cursorStep !== null ? cursorStep === s.index : hasRecording && playingStep === s.index) ? 'detail__step--playing' : ''}`}
                  >
                    {thumb && (
                      <a href={thumb} target="_blank" rel="noreferrer" className="detail__step-thumb">
                        <img src={thumb} alt={screenText ?? `step ${s.index}`} loading="lazy" />
                      </a>
                    )}
                    <div className="detail__step-text">
                      <div className="detail__step-head">
                        {typeof s.at === 'string' && Number.isFinite(Date.parse(s.at)) ? (
                          <button
                            type="button"
                            className="detail__step-idx detail__step-idx--btn"
                            title={pt('seekStep', lang)}
                            onClick={() => seekTo(Date.parse(s.at as string), false)}
                          >
                            #{s.index}
                          </button>
                        ) : (
                          <span className="detail__step-idx">#{s.index}</span>
                        )}
                        {typeof s.at === 'string' && Number.isFinite(Date.parse(s.at)) && (
                          <time className="detail__step-time" dateTime={s.at} title={new Date(s.at).toString()}>
                            {stepTime(s.at, locale)}
                          </time>
                        )}
                        {screenText && <span className="detail__step-screen">{screenText}</span>}
                        {actionText && <span className="detail__step-action">{actionText}</span>}
                        {hasAudio && typeof s.at === 'string' && (() => {
                          // 這一步的時間窗:本步開始 → 下一步開始(最新一步用本步耗時)。
                          const from = Date.parse(s.at as string);
                          const next = steps.find((x) => x.index === s.index + 1);
                          const to = next && typeof next.at === 'string'
                            ? Date.parse(next.at as string)
                            : from + (typeof s.durationMs === 'number' ? (s.durationMs as number) : 8000);
                          return <StepSound s={soundInWindow(audioLevels, from, to)} lang={lang} />;
                        })()}
                        {hasRecording && typeof s.at === 'string' && (
                          <button
                            type="button"
                            className="detail__step-replay"
                            onClick={() => seekTo(Date.parse(s.at as string), true)}
                            aria-label={pt('replayStep', lang).replace('{n}', String(s.index))}
                          >
                            <InfoIcon name="playFill" size={11} /> {pt('replay', lang)}
                          </button>
                        )}
                      </div>
                      {(() => {
                        // 決策 Agent 給這一步的目標 + 輔助 Agent 判斷這一步的動作有沒有生效。
                        const plan = s.plan as { goal?: unknown; scriptStep?: unknown; scriptTotal?: unknown } | undefined;
                        const review = s.review as { effect?: unknown; note?: unknown } | undefined;
                        const goal = asText(plan?.goal);
                        const effect = asText(review?.effect);
                        const effectKey = effect === 'ok' ? 'effectOk' : effect === 'no_effect' ? 'effectNone' : effect === 'unexpected' ? 'effectOther' : null;
                        // runner 即時數值把關(疑似讀錯 / 投注額變更),每筆都標出前後步驟與數值。
                        const warnings = Array.isArray(s.warnings) ? (s.warnings as Array<Record<string, unknown>>) : [];
                        const nf = (v: unknown) => (typeof v === 'number' ? v.toLocaleString() : String(v ?? '?'));
                        const warnText = warnings.map((w) => {
                          if (w.kind === 'suspect_value') {
                            const prev = w.prev as { step?: unknown; value?: unknown } | undefined;
                            return pt('suspectValue', lang).replace('{k}', String(w.key)).replace('{v}', nf(w.value)).replace('{s}', String(prev?.step ?? '?')).replace('{p}', nf(prev?.value));
                          }
                          if (w.kind === 'bet_changed') return pt('betChanged', lang).replace('{f}', nf(w.from)).replace('{t}', nf(w.to)).replace('{s}', String(w.sinceStep ?? '?'));
                          return null;
                        }).filter((x): x is string => !!x);
                        const seg = typeof s.segment === 'number' && (s.segment as number) > 1 ? (s.segment as number) : null;
                        if (!goal && !effectKey && warnText.length === 0 && !seg) return null;
                        return (
                          <div className="detail__step-team">
                            {seg && <span className="detail__step-effect">{pt('segment', lang).replace('{n}', String(seg))}</span>}
                            {warnText.map((w, j) => <span key={j} className="detail__step-effect is-unexpected">{w}</span>)}
                            {goal && (
                              <span className="detail__step-goal" title={pt('goalHint', lang)}>
                                <InfoIcon name="target" size={12} /> {typeof plan?.scriptStep === 'number' && typeof plan?.scriptTotal === 'number' && (plan.scriptTotal as number) > 1
                                  ? `${pt('scriptStep', lang).replace('{n}', String(plan.scriptStep)).replace('{m}', String(plan.scriptTotal))} · `
                                  : ''}
                                {goal}
                              </span>
                            )}
                            {effectKey && (
                              <span className={`detail__step-effect is-${effect}`} title={asText(review?.note) ?? pt('effectHint', lang)}>
                                {pt(effectKey, lang)}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      <StepMemoryChips memory={s.memory} lang={lang} />
                      {opCmds.map((txt, j) => (
                        <div key={j} className="detail__step-opcmd">
                          <InfoIcon name="msg" size={12} /> {txt}
                        </div>
                      ))}
                      {thinkingText && <div className="detail__step-think">{thinkingText}</div>}
                      {urlText && <div className="detail__step-url">{urlText}</div>}
                      {typeof s.httpStatus === 'number' && <div>HTTP {s.httpStatus}</div>}
                      {titleText && <div className="detail__step-title">{titleText}</div>}
                    </div>
                  </li>
                );
              })}
            </ol>
            </>
          )}
          </div>
          )}
        </section>

      {/* 時間軸:拖到哪一刻,錄影、這一刻、執行軌跡、日誌都跟著跳到那一刻(不超過 1/4 高) */}
      {steps.length > 0 && (
        <div className="dstage__tl">
          <TaskTimeline
            tl={timeline}
            cursor={cursor}
            onSeek={seekTo}
            lang={lang}
            hasVideo={hasRecording}
            playing={videoPlaying}
            onTogglePlay={() => {
              // 還沒選時間就按播放:從播放頭(或開頭)開始。
              if (cursor === null) seekTo(timeline.origin, true);
              else setPlayCtl((p) => ({ action: 'toggle', n: (p?.n ?? 0) + 1 }));
            }}
            follow={isLive}
            {...(isLive && cursor !== null ? { onLive: () => setCursor(null), liveLabel: pt('liveFollow', lang) } : {})}
          />
        </div>
      )}
      </div>
    </section>
  );
}
