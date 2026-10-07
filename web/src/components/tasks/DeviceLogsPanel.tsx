import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from '../../api/client.ts';
import type { RLang } from '../report/reportText.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { AgentLogView, useTraces, type AgentSeat } from './AgentLogView.tsx';
import { LiveAnalysisView } from './LiveAnalysisView.tsx';
import { UsageView } from './UsageView.tsx';
import type { MetaSeat } from '../../api/useJobStream.ts';
import './DeviceLogsPanel.css';

/** 文案:[繁中, English, 简中, 日本語, 한국어](依介面語系)。 */
const T = {
  analysis: ["分析", "Analysis", "分析", "分析", "분석"],
  usage: ["用量", "Usage", "用量", "使用量", "사용량"],
  analysisHint: ["勾選要追蹤的指標,測試中即時計算(與測試報告同一套指標)", "Track the metrics you pick, calculated live during the test (same metrics as the test report)", "勾选要追踪的指标,测试中实时计算(与测试报告同一套指标)", "選んだ指標をテスト中にリアルタイムで計算(テストレポートと同じ指標)", "선택한 지표를 테스트 중 실시간 계산(테스트 보고서와 같은 지표)"],
  usageHint: ["每個 Agent 的 Token 用量與估算費用", "Token usage and estimated cost per agent", "每个 Agent 的 Token 用量与估算费用", "Agent ごとのトークン使用量と推定費用", "Agent별 토큰 사용량과 예상 비용"],
  agentNotCalled: ["這次測試的執行程式只會呼叫「視覺 Agent」。這個 Agent 雖然有選模型,但執行時沒有被呼叫,所以沒有紀錄(也不會產生它的費用)。","This run only calls the Vision Agent. A model is selected for this agent, but it is never called during the run, so there are no records (and no cost for it).","这次测试的执行程序只会调用「视觉 Agent」。这个 Agent 虽然选了模型,但执行时没有被调用,所以没有记录(也不会产生它的费用)。","このテストの実行プログラムは「ビジョン Agent」だけを呼び出します。この Agent はモデルが選択されていますが、実行中に呼び出されないため記録はありません(費用も発生しません)。","이번 테스트 실행 프로그램은 \"비전 Agent\"만 호출합니다. 이 Agent는 모델이 선택되어 있지만 실행 중 호출되지 않아 기록이 없습니다(비용도 발생하지 않음)."],
  agentVlm: ["視覺","Vision","视觉","ビジョン","비전"],
  agentMain: ["決策","Decision","决策","判断","결정"],
  agentSub: ["輔助","Helper","辅助","補助","보조"],
  agentVlmHint: ["看畫面、決定下一步點哪裡(每一步一筆)","Reads the screen and picks where to act next (one entry per step)","看画面、决定下一步点哪里(每一步一笔)","画面を読み取り、次の操作位置を決める(1ステップ1件)","화면을 읽고 다음 조작 위치를 결정(단계당 1건)"],
  agentMainHint: ["控制遊戲流程、做整體判斷(每一步一筆)","Drives the game flow and makes overall decisions (one entry per step)","控制游戏流程、做整体判断(每一步一笔)","ゲーム進行を制御し全体を判断する(1ステップ1件)","게임 진행을 제어하고 전체 판단(단계당 1건)"],
  agentSubHint: ["處理輔助的小任務(每一步一筆)","Handles small helper tasks (one entry per step)","处理辅助的小任务(每一步一笔)","補助的な小さな作業を担当(1ステップ1件)","보조 작업 처리(단계당 1건)"],
  agentEmpty: ["這次測試沒有這個 Agent 的紀錄(還沒開始,或這個 Agent 沒有被呼叫)。","No records for this agent in this run (not started yet, or this agent was not called).","这次测试没有这个 Agent 的记录(还没开始,或这个 Agent 没有被调用)。","このテストではこの Agent の記録がありません(未開始、または呼び出されていません)。","이번 테스트에 이 Agent 기록이 없습니다(아직 시작 전이거나 호출되지 않음)."],
  title: ["日誌檢視", "Log viewer", "日志查看", "ログビューア", "로그 뷰어"],
  newestFirst: [
    "最新在上",
    "Newest first",
    "最新在上",
    "新しい順",
    "최신순"
  ],
  logcat: ["裝置", "Device", "设备", "デバイス", "기기"],
  audio: ["音效", "Sound", "音效", "サウンド", "사운드"],
  lvAll: [
    "全部",
    "Everything",
    "全部",
    "すべて",
    "전체"
  ],
  lvInfo: [
    "一般以上(略過除錯訊息)",
    "Info and above (skip debug)",
    "一般以上(略过调试信息)",
    "通常以上(デバッグを除く)",
    "일반 이상(디버그 제외)"
  ],
  lvWarn: [
    "只看警告和錯誤",
    "Warnings and errors",
    "只看警告和错误",
    "警告とエラーのみ",
    "경고와 오류만"
  ],
  lvError: [
    "只看錯誤",
    "Errors only",
    "只看错误",
    "エラーのみ",
    "오류만"
  ],
  show_: [
    "顯示",
    "Show",
    "显示",
    "表示",
    "표시"
  ],
  loading: [
    "載入中…",
    "Loading…",
    "加载中…",
    "読み込み中…",
    "불러오는 중…"
  ],
  empty: [
    "沒有資料(這個任務開始時還沒有收集裝置 Log,或裝置不支援)。",
    "No data (device logs were not collected for this run, or the device does not support it).",
    "没有数据(这个任务开始时还没有收集设备 Log,或设备不支持)。",
    "データがありません(このテストではデバイスログを収集していないか、デバイスが非対応です)。",
    "데이터가 없습니다(이 테스트에서는 기기 로그를 수집하지 않았거나 기기가 지원하지 않습니다)."
  ],
  search: [
    "搜尋",
    "Search",
    "搜索",
    "検索",
    "검색"
  ],
  appOnly: [
    "只看這款遊戲",
    "This game only",
    "只看这款游戏",
    "このゲームのみ",
    "이 게임만"
  ],
  download: [
    "下載",
    "Download",
    "下载",
    "ダウンロード",
    "다운로드"
  ],
  truncated: [
    "只顯示最新 {n} 行,完整內容請下載。",
    "Showing the newest {n} lines; download for the full log.",
    "只显示最新 {n} 行,完整内容请下载。",
    "最新 {n} 行のみ表示しています。全体はダウンロードしてください。",
    "최신 {n}줄만 표시합니다. 전체 내용은 다운로드하세요."
  ],
  lvW: [
    "警告",
    "Warning",
    "警告",
    "警告",
    "경고"
  ],
  lvE: [
    "錯誤",
    "Error",
    "错误",
    "エラー",
    "오류"
  ],
  lines: [
    "{n} 行",
    "{n} lines",
    "{n} 行",
    "{n} 行",
    "{n}줄"
  ],
  colStep: [
    "步驟",
    "Step",
    "步骤",
    "ステップ",
    "단계"
  ],
  colTime: [
    "時間",
    "Time",
    "时间",
    "時刻",
    "시간"
  ],
  colPlayers: [
    "播放器",
    "Players",
    "播放器",
    "プレーヤー",
    "플레이어"
  ],
  colOutput: [
    "聲音輸出",
    "Output",
    "声音输出",
    "音声出力",
    "오디오 출력"
  ],
  playing: [
    "播放中",
    "Playing",
    "播放中",
    "再生中",
    "재생 중"
  ],
  outActive: [
    "輸出中",
    "Active",
    "输出中",
    "出力中",
    "출력 중"
  ],
  outStandby: [
    "待機",
    "Standby",
    "待机",
    "待機",
    "대기"
  ],
  raw: [
    "原始內容",
    "Raw",
    "原始内容",
    "生データ",
    "원본"
  ],
  audioHint: [
    "「播放中」= 有播放器正在播放;「輸出中」= 聲音輸出沒有待機。多數遊戲引擎把所有音效混成一條聲音軌,這裡通常只看得出聲音系統有沒有在跑,分不出個別音效,也分不出正在播哪一段音樂(要從測試錄影的聲音做測後分析)。相同狀態的連續步驟會合併成一列。",
    "\"Playing\" = a player is playing; \"Active\" = the audio output is not in standby. Most engines mix every sound into one track, so this usually shows whether audio is running, not individual sound effects or which music track is playing (that needs post-test analysis of the recording audio). Consecutive steps with the same state are merged into one row.",
    "「播放中」= 有播放器正在播放;「输出中」= 声音输出没有待机。多数游戏引擎把所有音效混成一条声音轨,这里通常只看得出声音系统有没有在运行,分不出个别音效,也分不出正在播哪一段音乐(要从测试录像的声音做测后分析)。相同状态的连续步骤会合并成一行。",
    "「再生中」= 再生中のプレーヤーがある;「出力中」= 音声出力が待機していない。多くのゲームエンジンは全ての効果音を1本に混ぜるため、通常は音声が動いているかどうかだけが分かり、個々の効果音やどの BGM が流れているかは区別できません(録画の音声を使ったテスト後分析が必要です)。同じ状態の連続ステップは 1 行にまとめます。",
    "\"재생 중\" = 재생 중인 플레이어가 있음, \"출력 중\" = 오디오 출력이 대기 상태가 아님. 대부분의 게임 엔진은 모든 효과음을 하나의 트랙으로 섞기 때문에 보통 소리가 나는지 여부만 알 수 있고 개별 효과음이나 어떤 음악이 재생 중인지는 구분할 수 없습니다(녹화 음성으로 테스트 후 분석이 필요합니다). 같은 상태가 이어지는 단계는 한 줄로 합칩니다."
  ],
  sameSteps: [
    "{n} 步狀態相同",
    "{n} steps, same state",
    "{n} 步状态相同",
    "{n} ステップ同じ状態",
    "{n}단계 동일한 상태"
  ],
  loadError: [
    "讀取失敗",
    "Failed to load",
    "读取失败",
    "読み込みに失敗しました",
    "불러오지 못했습니다"
  ]
} as const;
const LOC_IDX: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };
const tx = (k: keyof typeof T, loc: string): string => (T[k] as readonly string[])[LOC_IDX[loc] ?? 1] ?? T[k][1];

interface Page<I> { items: I[]; cursor?: string; more: boolean }
interface LogChunk { name: string; text?: string }
interface Player { piid: number; pid?: number; usage?: string; content?: string; type?: string; state?: string }
interface Output { thread: string; standby?: boolean; tracks?: number; active?: number }
interface AudioSnap { step: number; at: number; pid?: number; players: Player[]; outputs: Output[]; playbackRaw?: string; flingerRaw?: string }

export interface LogLine { t: number; pid: number; tid: number; level: string; tag: string; msg: string; raw: string }

const LINE_RE = /^\s*(\d{9,}\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s?(.*)$/;
const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F', 'A'];
const MAX_RENDER = 2000;

/** logcat(-v epoch)文字 → 行;回傳行與片段標頭裡的被測 App pid。 */
export function parseLogcat(text: string): { lines: LogLine[]; pid?: number } {
  const lines: LogLine[] = [];
  let pid: number | undefined;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('#')) {
      const m = /pid=(\d+)/.exec(raw);
      if (m) pid = Number(m[1]);
      continue;
    }
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    lines.push({ t: Math.round(Number(m[1]) * 1000), pid: Number(m[2]), tid: Number(m[3]), level: m[4]!, tag: m[5]!, msg: m[6]!, raw });
  }
  return { lines, ...(pid ? { pid } : {}) };
}

const hms = (ms: number) => {
  const d = new Date(ms);
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

/** 依序讀完所有頁(執行中由呼叫端定期以游標續讀)。 */
async function readAll<I>(jobId: string, kind: string, after: string | undefined, maxPages = 20): Promise<{ items: I[]; cursor?: string }> {
  const items: I[] = [];
  let cursor = after;
  for (let p = 0; p < maxPages; p++) {
    const q = new URLSearchParams({ kind, ...(cursor ? { after: cursor } : {}) });
    const page = await apiGet<Page<I>>(`/tasks/${encodeURIComponent(jobId)}/device-logs?${q.toString()}`);
    items.push(...page.items);
    if (page.cursor) cursor = page.cursor;
    if (!page.more || page.items.length === 0) break;
  }
  return { items, ...(cursor ? { cursor } : {}) };
}

/** 任務詳情頁右欄:真機 log(一直展開,最新在上)。 */
type Tab = 'logcat' | 'audio' | AgentSeat | 'analysis' | 'usage';
const TAB_LABEL: Record<Tab, keyof typeof T> = { logcat: 'logcat', audio: 'audio', vlm: 'agentVlm', agent: 'agentMain', subagent: 'agentSub', analysis: 'analysis', usage: 'usage' };
const TAB_HINT: Partial<Record<Tab, keyof typeof T>> = { vlm: 'agentVlmHint', agent: 'agentMainHint', subagent: 'agentSubHint', analysis: 'analysisHint', usage: 'usageHint' };

/**
 * 任務詳情頁右欄「日誌檢視」:裝置系統 Log / 音效播放狀態(真機才有)+ 三個 AI Agent 每一步的互動紀錄。
 * device=false(非真機)時只顯示 AI Agent 分頁。lang 保留相容;文案依介面語系(五語)。
 */
export function DeviceLogsPanel({ jobId, isLive, device = true, appId, seats = [] }: { jobId: string; isLive: boolean; device?: boolean; appId?: string; seats?: MetaSeat[]; lang?: RLang }) {
  const { locale: loc } = useI18n();
  // 順序:裝置 → 音效 → 視覺 → 決策 → 輔助 → 分析 → 用量(視覺 → 決策 → 輔助 = 每一步的執行順序)。
  // 預設:真機停在裝置;非真機停在視覺。
  const agentTabs: Tab[] = ['vlm', 'agent', 'subagent', 'analysis', 'usage'];
  const tabs: Tab[] = device ? ['logcat', 'audio', ...agentTabs] : agentTabs;
  // 頁面剛載入時還不知道是不是真機任務(device 會從 false 變 true):使用者沒點過分頁前,預設跟著 device 走。
  const [picked, setTab] = useState<Tab | null>(null);
  const tab: Tab = picked && tabs.includes(picked) ? picked : device ? 'logcat' : 'vlm';
  const isAgent = tab === 'vlm' || tab === 'agent' || tab === 'subagent';
  const traces = useTraces(jobId, isLive, isAgent, isAgent ? (tab as AgentSeat) : 'summary');
  const usageTraces = useTraces(jobId, isLive, tab === 'usage', 'summary');
  const hint = TAB_HINT[tab];
  return (
    <div className="devlogs" role="region" aria-labelledby="devlogs-title">
      <h2 id="devlogs-title" className="detail__panel-title">
        {tx('title', loc)}
      </h2>
      <div className="devlogs__tabs" role="tablist">
        {tabs.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`devlogs__tab ${tab === k ? 'is-on' : ''}`}
            title={TAB_HINT[k] ? tx(TAB_HINT[k]!, loc) : undefined}
            onClick={() => setTab(k)}
          >
            {tx(TAB_LABEL[k], loc)}
          </button>
        ))}
      </div>
      {hint && <p className="devlogs__muted">{tx(hint, loc)}</p>}
      {tab === 'logcat' ? (
        <LogcatView jobId={jobId} isLive={isLive} />
      ) : tab === 'audio' ? (
        <AudioView jobId={jobId} isLive={isLive} />
      ) : tab === 'analysis' ? (
        <div className="devlogs__agent-wrap">
          <LiveAnalysisView jobId={jobId} isLive={isLive} {...(appId ? { appId } : {})} loc={loc} />
        </div>
      ) : tab === 'usage' ? (
        <div className="devlogs__agent-wrap">
          <UsageView traces={usageTraces} seats={seats} loc={loc} />
        </div>
      ) : (
        <div className="devlogs__agent-wrap">
          <AgentLogView
            traces={traces}
            seat={tab as AgentSeat}
            emptyText={tx('agentEmpty', loc)}
            loadingText={tx('loading', loc)}
          />
        </div>
      )}
    </div>
  );
}

/** 讀取並(執行中時)每 5 秒以游標續讀。 */
function useDeviceLog<I>(jobId: string, kind: 'logcat' | 'audio', isLive: boolean) {
  const [items, setItems] = useState<I[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const cursor = useRef<string | undefined>(undefined);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    cursor.current = undefined;
    setItems([]);
    setLoading(true);
    setError(false);
    const load = async () => {
      try {
        const r = await readAll<I>(jobId, kind, cursor.current);
        if (stop) return;
        if (r.cursor) cursor.current = r.cursor;
        if (r.items.length) setItems((prev) => [...prev, ...r.items]);
      } catch {
        if (!stop) setError(true);
      } finally {
        if (!stop) setLoading(false);
      }
      if (!stop && isLive) timer = setTimeout(() => void load(), 5000);
    };
    void load();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [jobId, kind, isLive]);
  return { items, loading, error };
}

function LogcatView({ jobId, isLive }: { jobId: string; isLive: boolean }) {
  const { locale: loc } = useI18n();
  const { items, loading, error } = useDeviceLog<LogChunk>(jobId, 'logcat', isLive);
  const [query, setQuery] = useState('');
  const [minLevel, setMinLevel] = useState('V');
  const [appOnly, setAppOnly] = useState(false);

  const { lines, appPids } = useMemo(() => {
    const all: LogLine[] = [];
    const pids = new Set<number>();
    for (const c of items) {
      const p = parseLogcat(c.text ?? '');
      if (p.pid) pids.add(p.pid);
      all.push(...p.lines);
    }
    return { lines: all, appPids: pids };
  }, [items]);
  const filtered = useMemo(() => {
    const lv = LEVELS.indexOf(minLevel);
    const q = query.trim().toLowerCase();
    return lines.filter((l) => LEVELS.indexOf(l.level) >= lv && (!appOnly || appPids.has(l.pid)) && (!q || l.raw.toLowerCase().includes(q)));
  }, [lines, minLevel, appOnly, appPids, query]);
  // 最新在上:取最新的 MAX_RENDER 行再反轉。
  const shown = (filtered.length > MAX_RENDER ? filtered.slice(-MAX_RENDER) : filtered).slice().reverse();

  function download() {
    const blob = new Blob([items.map((c) => c.text ?? '').join('')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${jobId}-logcat.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  if (loading && items.length === 0) return <p className="devlogs__muted">{tx('loading', loc)}</p>;
  if (error && items.length === 0) return <p className="devlogs__muted" role="alert">{tx('loadError', loc)}</p>;
  if (lines.length === 0) return <p className="devlogs__muted">{tx('empty', loc)}</p>;
  return (
    <>
      <div className="devlogs__bar">
        <input
          type="search"
          className="devlogs__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tx('search', loc)}
          aria-label={tx('search', loc)}
        />
        <label className="devlogs__inline">
          <span>{tx('show_', loc)}</span>
          <select value={minLevel} onChange={(e) => setMinLevel(e.target.value)}>
            <option value="V">{tx('lvAll', loc)}</option>
            <option value="I">{tx('lvInfo', loc)}</option>
            <option value="W">{tx('lvWarn', loc)}</option>
            <option value="E">{tx('lvError', loc)}</option>
          </select>
        </label>
        <label className="devlogs__inline">
          <input type="checkbox" checked={appOnly} onChange={(e) => setAppOnly(e.target.checked)} disabled={appPids.size === 0} />
          <span>{tx('appOnly', loc)}</span>
        </label>
        <span className="devlogs__spacer" />
        <span className="devlogs__muted">{tx('lines', loc).replace('{n}', String(filtered.length))}</span>
        <button type="button" className="devlogs__btn" onClick={download}>{tx('download', loc)}</button>
      </div>
      {filtered.length > MAX_RENDER && <p className="devlogs__muted">{tx('truncated', loc).replace('{n}', String(MAX_RENDER))}</p>}
      <div className="devlogs__log" role="log" aria-live="off" tabIndex={0}>
        {shown.map((l, i) => (
          <div key={i} className={`devlogs__line is-${l.level}`}>
            <span className="devlogs__t">{hms(l.t)}</span>
            <span className="devlogs__lv" title={l.level}>
              {l.level === 'W' ? tx('lvW', loc) : l.level === 'E' || l.level === 'F' || l.level === 'A' ? tx('lvE', loc) : ''}
            </span>
            <span className="devlogs__tag">{l.tag}</span>
            <span className="devlogs__msg">{l.msg}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** 一份音效快照的「狀態」:本應用的播放器(類型/用途/狀態)+ 有在輸出的聲道數。 */
function audioSignature(s: AudioSnap): string {
  const players = (s.pid ? s.players.filter((p) => p.pid === s.pid) : s.players)
    .map((p) => [p.type, p.usage, p.content, p.state].join('/')).sort().join(',');
  const active = s.outputs.filter((o) => o.standby === false || (o.active ?? 0) > 0).length;
  return `${players}|${active}`;
}

function AudioView({ jobId, isLive }: { jobId: string; isLive: boolean }) {
  const { locale: loc } = useI18n();
  const { items, loading, error } = useDeviceLog<{ name: string; data?: AudioSnap }>(jobId, 'audio', isLive);
  const snaps = useMemo(() => items.map((i) => i.data).filter((d): d is AudioSnap => !!d).reverse(), [items]);
  // 新→舊排列;相鄰且狀態一樣(播放器、輸出)的快照合併成一列,顯示步驟範圍。
  const rows = useMemo(() => {
    const out: Array<{ s: AudioSnap; first: number; count: number; sig: string }> = [];
    for (const snap of snaps) {
      const sig = audioSignature(snap);
      const last = out[out.length - 1];
      if (last && last.sig === sig) { last.first = snap.step; last.count += 1; continue; }
      out.push({ s: snap, first: snap.step, count: 1, sig });
    }
    return out;
  }, [snaps]);
  if (loading && items.length === 0) return <p className="devlogs__muted">{tx('loading', loc)}</p>;
  if (error && items.length === 0) return <p className="devlogs__muted" role="alert">{tx('loadError', loc)}</p>;
  if (snaps.length === 0) return <p className="devlogs__muted">{tx('empty', loc)}</p>;
  return (
    <>
      <p className="devlogs__muted">{tx('audioHint', loc)}</p>
      <div className="devlogs__table-wrap">
        <table className="devlogs__table">
          <thead>
            <tr>
              <th scope="col">{tx('colStep', loc)}</th>
              <th scope="col">{tx('colTime', loc)}</th>
              <th scope="col">{tx('colPlayers', loc)}</th>
              <th scope="col">{tx('colOutput', loc)}</th>
              <th scope="col">{tx('raw', loc)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, first, count }, k) => {
              const appPlayers = s.pid ? s.players.filter((p) => p.pid === s.pid) : s.players;
              const playing = appPlayers.filter((p) => p.state === 'started');
              const active = s.outputs.filter((o) => o.standby === false || (o.active ?? 0) > 0);
              return (
                <tr key={k} className={playing.length ? 'is-playing' : ''}>
                  <td>
                    {count > 1 ? <>#{first}–#{s.step}<div className="devlogs__muted">{tx('sameSteps', loc).replace('{n}', String(count))}</div></> : <>#{s.step}</>}
                  </td>
                  <td className="devlogs__t">{hms(s.at)}</td>
                  <td>
                    {playing.length > 0 && <span className="devlogs__pill is-on">♪ {tx('playing', loc)} {playing.length}</span>}
                    {appPlayers.map((p) => (
                      <span key={p.piid} className="devlogs__player">{[p.type, p.usage, p.state].filter(Boolean).join(' · ')}</span>
                    ))}
                    {appPlayers.length === 0 && '—'}
                  </td>
                  <td>
                    {active.length > 0
                      ? <span className="devlogs__pill is-on">{tx('outActive', loc)} {active.length}</span>
                      : <span className="devlogs__pill">{tx('outStandby', loc)}</span>}
                  </td>
                  <td>
                    <details>
                      <summary>{tx('raw', loc)}</summary>
                      <pre className="devlogs__raw">{`${s.playbackRaw ?? ''}\n${s.flingerRaw ?? ''}`.trim() || '—'}</pre>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
