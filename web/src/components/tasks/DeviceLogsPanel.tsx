import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from '../../api/client.ts';
import type { RLang } from '../report/reportText.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { AgentLogView, useTraces, type AgentSeat } from './AgentLogView.tsx';
import type { AudioLevels } from './audioLevels.ts';
import { buildSoundEvents, type SoundKind, type StepRef } from './soundEvents.ts';
import { clockOffset, parseLogcat, type LogLine } from './logcat.ts';
import { fmtClock, lastAtOrBefore } from './timeline.ts';
import './DeviceLogsPanel.css';

/** 文案:[繁中, English, 简中, 日本語, 한국어](依介面語系)。 */
const T = {
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
  truncatedNear: ["只顯示時間軸播放頭附近 {n} 行,完整內容請下載。", "Showing {n} lines around the timeline playhead; download for the full log.", "只显示时间轴播放头附近 {n} 行,完整内容请下载。", "再生ヘッド付近の {n} 行のみ表示しています。全体はダウンロードしてください。", "재생 헤드 근처 {n}줄만 표시합니다. 전체 내용은 다운로드하세요."],
  follow: ["跟著時間軸捲動", "Follow the timeline", "跟着时间轴滚动", "タイムラインに追従", "타임라인 따라가기"],
  seekHere: ["跳到這一刻", "Jump to this moment", "跳到这一刻", "この時点へ移動", "이 시점으로 이동"],
  deviceTime: ["裝置時間", "Device time", "设备时间", "端末時刻", "기기 시간"],
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
  sndGame: ["遊戲音效", "Game sound", "游戏音效", "ゲーム効果音", "게임 효과음"],
  sndFail: ["沒播出", "Failed", "没播出", "再生失敗", "재생 실패"],
  sndOnset: ["錄影偵測", "Heard in recording", "录像侦测", "録画で検出", "녹화 감지"],
  sndStream: ["聲音串流", "Audio stream", "声音串流", "音声ストリーム", "오디오 스트림"],
  sndCol: ["聲音", "Sound", "声音", "サウンド", "사운드"],
  sndHeard: ["錄影有聲", "In recording", "录像有声", "録画に音", "녹화에 소리"],
  sndHeardYesShort: ["有", "Yes", "有", "あり", "있음"],
  sndHeardNoShort: ["沒聽到", "Silent", "没听到", "無音", "없음"],
  sndHeardYes: ["遊戲呼叫播放後 1 秒內,錄影裡有聽到聲音", "The recording has a sound within 1 s after the game played it", "游戏调用播放后 1 秒内,录像里有听到声音", "ゲームが再生してから 1 秒以内に録画で音が聞こえた", "게임이 재생한 뒤 1초 안에 녹화에서 소리가 들림"],
  sndHeardNo: ["遊戲呼叫播放後 1 秒內,錄影裡沒有聽到突然的聲音(可能沒播出來,或被背景音樂蓋過)", "No sudden sound in the recording within 1 s (it may not have played, or the music covered it)", "游戏调用播放后 1 秒内,录像里没有听到突然的声音(可能没播出来,或被背景音乐盖过)", "1 秒以内に録画で目立つ音がない(再生されていないか、BGM に埋もれた可能性)", "1초 안에 녹화에서 뚜렷한 소리가 없음(재생되지 않았거나 배경음에 묻혔을 수 있음)"],
  sndOnsetTitle: ["突發聲音 · 最大 {db} dB · {s} 秒", "Sudden sound · peak {db} dB · {s}s", "突发声音 · 最大 {db} dB · {s} 秒", "突発音 · 最大 {db} dB · {s} 秒", "갑작스러운 소리 · 최대 {db} dB · {s}초"],
  sndReplay: ["回放這個時間點", "Replay this moment", "回放这个时间点", "この時点を再生", "이 시점 재생"],
  sndSnaps: ["播放器狀態快照(系統層)", "Player state snapshots (system)", "播放器状态快照(系统层)", "プレーヤー状態スナップショット(システム)", "플레이어 상태 스냅샷(시스템)"],
  sndEmpty: ["還沒有聲音事件(遊戲還沒出聲,或這次測試沒有收集裝置 Log / 錄影)。", "No sound events yet (no sound so far, or this run has no device logs / recording).", "还没有声音事件(游戏还没出声,或这次测试没有收集设备 Log / 录像)。", "まだサウンドイベントがありません(まだ音が出ていないか、ログ / 録画がありません)。", "아직 사운드 이벤트가 없습니다(아직 소리가 없거나 로그 / 녹화가 없습니다)."],
  sndHint: ["每列是一個聲音事件:遊戲音效 = 遊戲 log 回報的播放(含音效名稱);錄影偵測 = 錄影聲音裡突然變大聲的時刻;「錄影有聲」對照遊戲呼叫播放後有沒有真的聽到。點標題看完整 log,▶ 跳到錄影該時間。", "Each row is a sound event: Game sound = playback reported in the game log (with name); Heard in recording = moments the recording suddenly gets louder; \"In recording\" checks whether a played sound was actually heard. Click a title for the full log, ▶ jumps the recording.", "每行是一个声音事件:游戏音效 = 游戏 log 报告的播放(含音效名称);录像侦测 = 录像声音里突然变大声的时刻;「录像有声」对照游戏调用播放后有没有真的听到。点标题看完整 log,▶ 跳到录像该时间。", "各行がサウンドイベントです。ゲーム効果音 = ゲームログに出た再生(名前付き)、録画で検出 = 録画の音が急に大きくなった時点、「録画に音」= 再生後に実際に聞こえたか。タイトルで全ログ、▶ で録画へ。", "각 행이 사운드 이벤트입니다. 게임 효과음 = 게임 로그의 재생(이름 포함), 녹화 감지 = 녹화 소리가 갑자기 커진 시점, \"녹화에 소리\" = 재생 후 실제로 들렸는지. 제목을 누르면 전체 로그, ▶ 는 녹화로 이동."],
  sndHintNoLog: ["這款遊戲沒有在 log 裡回報播放了哪個音效,所以這裡只有「錄影偵測」的時間點,沒有音效名稱。實測 Unity 遊戲把所有音效混成同一條聲音串流,Android 系統層分不出個別音效。要看到名稱:請開發者在播放音效的地方加一行 log,例如 Debug.Log(\"[SFX] \" + clip.name),之後這裡就會列出每個音效名稱,並自動對照錄影有沒有真的出聲。", "This game does not log which sound it plays, so only recording-detected moments are listed, without names. Unity games mix every sound into one stream, so Android cannot tell sounds apart. To get names, ask the developers to log each play, e.g. Debug.Log(\"[SFX] \" + clip.name); each sound will then be listed by name and checked against the recording.", "这款游戏没有在 log 里报告播放了哪个音效,所以这里只有「录像侦测」的时间点,没有音效名称。实测 Unity 游戏把所有音效混成同一条声音串流,Android 系统层分不出个别音效。要看到名称:请开发者在播放音效的地方加一行 log,例如 Debug.Log(\"[SFX] \" + clip.name),之后这里就会列出每个音效名称,并自动对照录像有没有真的出声。", "このゲームは再生した効果音をログに出さないため、録画で検出した時点のみ(名前なし)です。Unity は全効果音を 1 本のストリームに混ぜるため Android では区別できません。名前を出すには再生箇所で Debug.Log(\"[SFX] \" + clip.name) のようにログを出してもらってください。", "이 게임은 어떤 효과음을 재생했는지 로그에 남기지 않아 녹화로 감지한 시점만(이름 없이) 표시됩니다. Unity 게임은 모든 효과음을 하나의 스트림으로 섞어 Android에서 구분할 수 없습니다. 이름을 보려면 재생 위치에 Debug.Log(\"[SFX] \" + clip.name) 같은 로그를 추가해 달라고 요청하세요."],
  sameSteps: [
    "{n} 步狀態相同",
    "{n} steps, same state",
    "{n} 步状态相同",
    "{n} ステップ同じ状態",
    "{n}단계 동일한 상태"
  ],
  source: ["來源", "Source", "来源", "ソース", "소스"],
  srcAll: ["全部", "All", "全部", "すべて", "전체"],
  srcUnity: ["Unity", "Unity", "Unity", "Unity", "Unity"],
  srcAudio: ["音效 / 媒體", "Audio / media", "音效 / 媒体", "音声 / メディア", "오디오 / 미디어"],
  srcNet: ["網路", "Network", "网络", "ネットワーク", "네트워크"],
  srcCrash: ["崩潰 / ANR", "Crash / ANR", "崩溃 / ANR", "クラッシュ / ANR", "크래시 / ANR"],
  srcTags: ["依標籤", "By tag", "按标签", "タグ別", "태그별"],
  tagClick: ["只看這個標籤", "Show only this tag", "只看这个标签", "このタグのみ表示", "이 태그만 보기"],
  clearFilter: ["清除篩選", "Clear filters", "清除筛选", "フィルター解除", "필터 해제"],
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
export interface LogChunk { name: string; text?: string }
export interface DeviceLogState<I> { items: I[]; loading: boolean; error: boolean }
/** 與任務時間軸連動:cursor = 播放頭(epoch ms),origin = 時間軸 0,onSeek = 移動播放頭。 */
interface TimeSync {
  cursor?: number | null;
  origin?: number;
  onSeek?: (t: number, play?: boolean) => void;
}
interface Player { piid: number; pid?: number; usage?: string; content?: string; type?: string; state?: string }
interface Output { thread: string; standby?: boolean; tracks?: number; active?: number }
interface AudioSnap { step: number; at: number; pid?: number; players: Player[]; outputs: Output[]; playbackRaw?: string; flingerRaw?: string }

export type { LogLine };
export { parseLogcat };

/**
 * 來源快選:依 logcat tag(必要時含訊息)分類。'tag:<名稱>' = 單一標籤。
 * 只看 Unity 時,Unity 引擎 / IL2CPP / Unity 外掛常用的 tag 都算進來。
 */
type SourcePreset = 'unity' | 'audio' | 'net' | 'crash';
const SOURCE_PRESETS: Array<{ id: SourcePreset; label: keyof typeof T; test: (l: LogLine) => boolean }> = [
  { id: 'unity', label: 'srcUnity', test: (l) => /^(unity|unitymain|unityads|unity\w*|il2cpp|mono|crashlytics-unity)$/i.test(l.tag) || /^unity/i.test(l.tag) },
  { id: 'audio', label: 'srcAudio', test: (l) => /audio|sound|media|aaudio|opensl|fmod|wwise|criware|exoplayer|codec|player/i.test(l.tag) },
  { id: 'net', label: 'srcNet', test: (l) => /net|http|okhttp|socket|conscrypt|dns|volley|cronet|ssl|tls|websocket|connectivity/i.test(l.tag) },
  {
    id: 'crash',
    label: 'srcCrash',
    test: (l) => /^(AndroidRuntime|DEBUG|libc|crash_dump\d*|tombstoned|CRASH)$/i.test(l.tag)
      || /FATAL EXCEPTION|ANR in |Fatal signal|SIGSEGV|SIGABRT|Application Not Responding|has died|Force finishing/i.test(l.msg),
  },
];
/** 篩選來源字串 → 判斷函式('' = 全部)。 */
export function sourceFilter(source: string): (l: LogLine) => boolean {
  if (!source) return () => true;
  if (source.startsWith('tag:')) { const tag = source.slice(4); return (l) => l.tag === tag; }
  return SOURCE_PRESETS.find((p) => p.id === source)?.test ?? (() => true);
}

const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F', 'A'];
const MAX_RENDER = 2000;

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

/**
 * 任務詳情頁右欄:真機 log(一直展開,最新在上)。
 * 「數據分析」與「Token 用量」原本也是這裡的分頁,已拉到任務詳情頁的上層分頁列
 * (LiveAnalysisView / UsageView),這裡只留逐步的 log 與三個 Agent 的互動紀錄。
 */
type Tab = 'logcat' | 'audio' | AgentSeat;
const TAB_LABEL: Record<Tab, keyof typeof T> = { logcat: 'logcat', audio: 'audio', vlm: 'agentVlm', agent: 'agentMain', subagent: 'agentSub' };
const TAB_HINT: Partial<Record<Tab, keyof typeof T>> = { vlm: 'agentVlmHint', agent: 'agentMainHint', subagent: 'agentSubHint' };

/**
 * 任務詳情頁右欄「日誌檢視」:裝置系統 Log / 音效播放狀態(真機才有)+ 三個 AI Agent 每一步的互動紀錄。
 * device=false(非真機)時只顯示 AI Agent 分頁。lang 保留相容;文案依介面語系(五語)。
 */
export function DeviceLogsPanel({ jobId, isLive, device = true, levels, steps, onSeek, cursor, origin, logcat, cursorStep }: {
  jobId: string;
  isLive: boolean;
  device?: boolean;
  lang?: RLang;
  /** 錄影聲音時間軸(音效分頁對照「有沒有真的聽到」)。 */
  levels?: AudioLevels | null;
  /** 步驟時間 + 畫面名(音效事件標上是哪一步)。 */
  steps?: StepRef[];
  /** 移動時間軸播放頭(epoch ms;play = 從那裡開始播錄影)。 */
  onSeek?: (t: number, play?: boolean) => void;
  /** 時間軸播放頭(epoch ms):log 捲到這一刻、AI 紀錄標出這一步。 */
  cursor?: number | null;
  /** 時間軸的 0(log 時間顯示成「分:秒.毫秒」,和時間軸一致)。 */
  origin?: number;
  /** 外層已讀好的 logcat(時間軸也要用,避免讀兩次)。 */
  logcat?: DeviceLogState<LogChunk>;
  /** 播放頭所在的步驟(AI 分頁標出這一步)。 */
  cursorStep?: number | null;
}) {
  const { locale: loc } = useI18n();
  const ownLog = useDeviceLog<LogChunk>(jobId, 'logcat', isLive, device && !logcat);
  const log = logcat ?? ownLog;
  const sync: TimeSync = { ...(cursor !== undefined ? { cursor } : {}), ...(origin !== undefined ? { origin } : {}), ...(onSeek ? { onSeek } : {}) };
  // 點 AI 紀錄的步驟 → 播放頭跳到那一步開始。
  const stepStart = useMemo(() => new Map((steps ?? []).map((s) => [s.index, s.t])), [steps]);
  const pickStep = onSeek ? (index: number) => { const t = stepStart.get(index); if (t !== undefined) onSeek(t, false); } : undefined;
  // 順序:裝置 → 音效 → 視覺 → 決策 → 輔助(視覺 → 決策 → 輔助 = 每一步的執行順序)。
  // 預設:真機停在裝置;非真機停在視覺。
  const agentTabs: Tab[] = ['vlm', 'agent', 'subagent'];
  const tabs: Tab[] = device ? ['logcat', 'audio', ...agentTabs] : agentTabs;
  // 頁面剛載入時還不知道是不是真機任務(device 會從 false 變 true):使用者沒點過分頁前,預設跟著 device 走。
  const [picked, setTab] = useState<Tab | null>(null);
  const tab: Tab = picked && tabs.includes(picked) ? picked : device ? 'logcat' : 'vlm';
  const isAgent = tab === 'vlm' || tab === 'agent' || tab === 'subagent';
  const traces = useTraces(jobId, isLive, isAgent, isAgent ? (tab as AgentSeat) : 'summary');
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
        <LogcatView jobId={jobId} log={log} sync={sync} />
      ) : tab === 'audio' ? (
        <AudioView jobId={jobId} isLive={isLive} log={log} sync={sync} {...(levels !== undefined ? { levels } : {})} {...(steps ? { steps } : {})} />
      ) : (
        <div className="devlogs__agent-wrap">
          <AgentLogView
            traces={traces}
            seat={tab as AgentSeat}
            emptyText={tx('agentEmpty', loc)}
            loadingText={tx('loading', loc)}
            {...(cursorStep !== undefined ? { activeIndex: cursorStep } : {})}
            {...(pickStep ? { onPick: pickStep } : {})}
          />
        </div>
      )}
    </div>
  );
}

/** 讀取並(執行中時)每 5 秒以游標續讀。enabled = false 不讀(外層已經讀好傳進來)。 */
export function useDeviceLog<I>(jobId: string, kind: 'logcat' | 'audio', isLive: boolean, enabled = true): DeviceLogState<I> {
  const [items, setItems] = useState<I[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const cursor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
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
  }, [jobId, kind, isLive, enabled]);
  return { items, loading, error };
}

function LogcatView({ jobId, log, sync }: { jobId: string; log: DeviceLogState<LogChunk>; sync: TimeSync }) {
  const { locale: loc } = useI18n();
  const { items, loading, error } = log;
  const [query, setQuery] = useState('');
  const [minLevel, setMinLevel] = useState('V');
  const [appOnly, setAppOnly] = useState(false);
  const [source, setSource] = useState('');

  // 時間換算成 runner 時鐘(與錄影、步驟、時間軸同一個時鐘);dev = 原本的裝置時間。
  const { lines, appPids } = useMemo(() => {
    const all: Array<LogLine & { dev: number }> = [];
    const pids = new Set<number>();
    for (const c of items) {
      const text = c.text ?? '';
      const p = parseLogcat(text);
      const off = clockOffset(text);
      if (p.pid) pids.add(p.pid);
      for (const l of p.lines) all.push({ ...l, dev: l.t, t: l.t + off });
    }
    return { lines: all, appPids: pids };
  }, [items]);
  // 每個來源 / 標籤有幾行(下拉選單顯示數量;沒有資料的快選不列)。
  const { presetCounts, tagCounts } = useMemo(() => {
    const pc: Record<string, number> = {};
    const tc = new Map<string, number>();
    for (const l of lines) {
      tc.set(l.tag, (tc.get(l.tag) ?? 0) + 1);
      for (const p of SOURCE_PRESETS) if (p.test(l)) pc[p.id] = (pc[p.id] ?? 0) + 1;
    }
    return { presetCounts: pc, tagCounts: [...tc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60) };
  }, [lines]);
  const filtered = useMemo(() => {
    const lv = LEVELS.indexOf(minLevel);
    const q = query.trim().toLowerCase();
    const src = sourceFilter(source);
    return lines.filter((l) => LEVELS.indexOf(l.level) >= lv && (!appOnly || appPids.has(l.pid)) && src(l) && (!q || l.raw.toLowerCase().includes(q)));
  }, [lines, minLevel, appOnly, appPids, query, source]);
  const filtering = !!(source || query.trim() || minLevel !== 'V' || appOnly);
  // 時間軸游標:有游標時顯示游標附近的 MAX_RENDER 行(不是只有最新的),最新在上。
  const cursor = sync.cursor ?? null;
  const sorted = useMemo(() => [...filtered].sort((a, b) => a.t - b.t), [filtered]);
  // 行數太多時只畫游標附近的一段;游標每 10 秒區間才換一次範圍(播放中不必每 0.1 秒重畫上千行)。
  const bucket = cursor === null ? null : Math.floor(cursor / 10_000);
  const shown = useMemo(() => {
    let slice = sorted;
    if (sorted.length > MAX_RENDER) {
      if (bucket !== null) {
        const i = Math.max(0, lastAtOrBefore(sorted, bucket * 10_000 + 5000, (l) => l.t));
        const from = Math.max(0, Math.min(sorted.length - MAX_RENDER, i - MAX_RENDER / 2));
        slice = sorted.slice(from, from + MAX_RENDER);
      } else slice = sorted.slice(-MAX_RENDER);
    }
    return slice.slice().reverse();
  }, [sorted, bucket]);
  // 最接近游標的那一行(高亮 + 捲到看得到;直接改 DOM class,不重畫整個清單)。
  const nearestIdx = useMemo(() => {
    if (cursor === null || !shown.length) return -1;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < shown.length; i++) {
      const d = Math.abs(shown[i]!.t - cursor);
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD <= 5000 ? best : -1;
  }, [shown, cursor]);
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.querySelectorAll('.devlogs__line.is-now').forEach((n) => n.classList.remove('is-now'));
    if (nearestIdx < 0) return;
    const el = box.querySelector<HTMLElement>(`[data-i="${nearestIdx}"]`);
    if (!el) return;
    el.classList.add('is-now');
    if (follow) {
      // 只捲 log 方塊本身(不捲整頁)。
      const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
      box.scrollTo({ top: Math.max(0, top) });
    }
  }, [nearestIdx, follow, shown]);
  const onSeek = sync.onSeek;
  const origin = sync.origin;
  const rows = useMemo(() => shown.map((l, i) => (
    <div key={i} data-i={i} className={`devlogs__line is-${l.level}`}>
      {onSeek ? (
        <button
          type="button"
          className="devlogs__t devlogs__t-btn"
          title={`${tx('seekHere', loc)} · ${hms(l.t)}${l.dev !== l.t ? ` · ${tx('deviceTime', loc)} ${hms(l.dev)}` : ''}`}
          onClick={() => onSeek(l.t, false)}
        >
          {origin !== undefined ? fmtClock(l.t - origin) : hms(l.t)}
        </button>
      ) : (
        <span className="devlogs__t">{hms(l.t)}</span>
      )}
      <span className="devlogs__lv" title={l.level}>
        {l.level === 'W' ? tx('lvW', loc) : l.level === 'E' || l.level === 'F' || l.level === 'A' ? tx('lvE', loc) : ''}
      </span>
      <button type="button" className="devlogs__tag" title={tx('tagClick', loc)} onClick={() => setSource(`tag:${l.tag}`)}>{l.tag}</button>
      <span className="devlogs__msg">{l.msg}</span>
    </div>
  )), [shown, onSeek, origin, loc]);

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
          <span>{tx('source', loc)}</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">{tx('srcAll', loc)}</option>
            {SOURCE_PRESETS.filter((p) => presetCounts[p.id] || source === p.id).map((p) => (
              <option key={p.id} value={p.id}>{tx(p.label, loc)} ({presetCounts[p.id] ?? 0})</option>
            ))}
            <optgroup label={tx('srcTags', loc)}>
              {source.startsWith('tag:') && !tagCounts.some(([t]) => `tag:${t}` === source) && <option value={source}>{source.slice(4)}</option>}
              {tagCounts.map(([t, n]) => <option key={t} value={`tag:${t}`}>{t} ({n})</option>)}
            </optgroup>
          </select>
        </label>
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
        {filtering && (
          <button type="button" className="devlogs__link" onClick={() => { setSource(''); setQuery(''); setMinLevel('V'); setAppOnly(false); }}>
            {tx('clearFilter', loc)}
          </button>
        )}
        <span className="devlogs__muted">{tx('lines', loc).replace('{n}', String(filtered.length))}</span>
        <button type="button" className="devlogs__btn" onClick={download}>{tx('download', loc)}</button>
      </div>
      {filtered.length > MAX_RENDER && <p className="devlogs__muted">{tx(bucket !== null ? 'truncatedNear' : 'truncated', loc).replace('{n}', String(MAX_RENDER))}</p>}
      {sync.onSeek && (
        <label className="devlogs__inline devlogs__follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          <span>{tx('follow', loc)}</span>
        </label>
      )}
      <div ref={boxRef} className="devlogs__log" role="log" aria-live="off" tabIndex={0}>
        {rows}
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

type SoundFilter = 'all' | SoundKind;
const SOUND_KINDS: Array<{ id: SoundKind; label: keyof typeof T; icon: string }> = [
  { id: 'game', label: 'sndGame', icon: '♪' },
  { id: 'fail', label: 'sndFail', icon: '⚠' },
  { id: 'onset', label: 'sndOnset', icon: '〰' },
  { id: 'stream', label: 'sndStream', icon: '⏯' },
];

/** 音效分頁:音效事件時間軸(遊戲 log + 錄影聲音 + 系統聲音串流)+ 收合的播放器狀態快照。 */
function AudioView({ jobId, isLive, log, sync, levels, steps }: { jobId: string; isLive: boolean; log: DeviceLogState<LogChunk>; sync: TimeSync; levels?: AudioLevels | null; steps?: StepRef[] }) {
  const { locale: loc } = useI18n();
  const logs = log;
  const onSeek = sync.onSeek;
  const cursor = sync.cursor ?? null;
  const [filter, setFilter] = useState<SoundFilter>('all');
  const [open, setOpen] = useState<number | null>(null);
  const events = useMemo(() => buildSoundEvents({ logChunks: logs.items, levels: levels ?? null, steps: steps ?? [] }), [logs.items, levels, steps]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of events) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [events]);
  const shown = (filter === 'all' ? events : events.filter((e) => e.kind === filter)).slice(0, 1500);
  const noGameLog = !counts['game'] && !counts['fail'];
  // 時間軸播放頭附近(±1 秒)的音效事件標出來。
  const nearT = (t: number) => cursor !== null && Math.abs(t - cursor) <= 1000;
  const tableRef = useRef<HTMLDivElement>(null);
  const firstNear = shown.findIndex((e) => nearT(e.t));
  useEffect(() => {
    if (firstNear < 0) return;
    const box = tableRef.current;
    const row = box?.querySelector<HTMLElement>(`[data-k="${firstNear}"]`);
    if (box && row) box.scrollTo({ top: Math.max(0, row.offsetTop - box.clientHeight / 2) });
  }, [firstNear]);
  const timeText = (t: number) => (sync.origin !== undefined ? fmtClock(t - sync.origin) : hms(t));
  return (
    <>
      <div className="devlogs__bar">
        <div className="devlogs__chips" role="group" aria-label={tx('source', loc)}>
          <button type="button" className={`devlogs__chip ${filter === 'all' ? 'is-on' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            {tx('srcAll', loc)} {events.length}
          </button>
          {SOUND_KINDS.filter((k) => counts[k.id]).map((k) => (
            <button key={k.id} type="button" className={`devlogs__chip is-${k.id} ${filter === k.id ? 'is-on' : ''}`} aria-pressed={filter === k.id} onClick={() => setFilter(k.id)}>
              {k.icon} {tx(k.label, loc)} {counts[k.id]}
            </button>
          ))}
        </div>
      </div>
      <p className="devlogs__muted">{tx(noGameLog ? 'sndHintNoLog' : 'sndHint', loc)}</p>
      {logs.loading && events.length === 0 ? (
        <p className="devlogs__muted">{tx('loading', loc)}</p>
      ) : events.length === 0 ? (
        <p className="devlogs__muted">{tx('sndEmpty', loc)}</p>
      ) : (
        <div ref={tableRef} className="devlogs__table-wrap">
          <table className="devlogs__table devlogs__snd">
            <thead>
              <tr>
                <th scope="col">{tx('colTime', loc)}</th>
                <th scope="col">{tx('colStep', loc)}</th>
                <th scope="col">{tx('sndCol', loc)}</th>
                <th scope="col">{tx('sndHeard', loc)}</th>
                {onSeek && <th scope="col"><span className="visually-hidden">{tx('sndReplay', loc)}</span></th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((e, k) => {
                const kind = SOUND_KINDS.find((x) => x.id === e.kind)!;
                const title = e.kind === 'onset'
                  ? tx('sndOnsetTitle', loc).replace('{db}', String(e.peakDb)).replace('{s}', ((e.durMs ?? 0) / 1000).toFixed(1))
                  : e.title;
                return (
                  <tr key={`${e.kind}-${e.t}-${k}`} data-k={k} className={`is-${e.kind}${nearT(e.t) ? ' is-now' : ''}`}>
                    <td className="devlogs__t">
                      {onSeek ? (
                        <button type="button" className="devlogs__t-btn" title={`${tx('seekHere', loc)} · ${hms(e.t)}`} onClick={() => onSeek(e.t, false)}>{timeText(e.t)}</button>
                      ) : hms(e.t)}
                    </td>
                    <td>{e.step !== undefined ? <>#{e.step}{e.screen && <div className="devlogs__muted">{e.screen}</div>}</> : '—'}</td>
                    <td>
                      <span className={`devlogs__snd-kind is-${e.kind}`} title={tx(kind.label, loc)}>{kind.icon}</span>{' '}
                      {e.detail ? (
                        <button type="button" className="devlogs__snd-title" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>{title}</button>
                      ) : <span className="devlogs__snd-title">{title}</span>}
                      {open === k && e.detail && <pre className="devlogs__raw">{e.detail}</pre>}
                    </td>
                    <td>
                      {e.heard === true && <span className="devlogs__pill is-on" title={tx('sndHeardYes', loc)}>✓ {tx('sndHeardYesShort', loc)}</span>}
                      {e.heard === false && <span className="devlogs__pill is-bad" title={tx('sndHeardNo', loc)}>✕ {tx('sndHeardNoShort', loc)}</span>}
                      {e.heard === undefined && (e.kind === 'onset' ? <span className="devlogs__muted">{e.peakDb} dB</span> : <span className="devlogs__muted">—</span>)}
                    </td>
                    {onSeek && (
                      <td>
                        <button type="button" className="devlogs__btn" onClick={() => onSeek(e.t - 500, true)} aria-label={tx('sndReplay', loc)} title={tx('sndReplay', loc)}>▶</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <details className="devlogs__snaps">
        <summary className="devlogs__muted">{tx('sndSnaps', loc)}</summary>
        <AudioSnapshots jobId={jobId} isLive={isLive} />
      </details>
    </>
  );
}

function AudioSnapshots({ jobId, isLive }: { jobId: string; isLive: boolean }) {
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
