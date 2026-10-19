import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost } from '../../api/client.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { loc5, pick5, type L5 } from '../../i18n/locale5.ts';
import './LogsPanel.css';

/** 與後端 systemLogs.ts 對齊。 */
type LogKind = 'lambda' | 'ecs' | 'codebuild' | 'other';
/** 後端給的翻譯 key(穩定,不隨語系變)。 */
type LogSourceId =
  | 'api' | 'engine' | 'dispatcher' | 'ws-auth' | 'ws-connect' | 'ws-push'
  | 'runner-exploration' | 'runner-web'
  | 'update' | 'image-runner' | 'image-web' | 'installer'
  | 'log-retention' | 's3-events' | 'custom-resource' | 'lambda-other' | 'other';
interface LogSource { id: string; logGroupName: string; kind: LogKind; sourceId?: LogSourceId; label: string }
type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
interface LogRow { ts: number; sourceId?: LogSourceId; source: string; logGroup: string; logStream?: string; level?: LogLevel; message: string }
type LogQueryState = 'Scheduled' | 'Running' | 'Complete' | 'Failed' | 'Cancelled' | 'Timeout' | 'Unknown';
interface LogQueryResult { status: LogQueryState; done: boolean; rows: LogRow[]; recordsMatched?: number }


const S = {
  section: ['集中日誌', 'Centralized logs', '集中日志', '集中ログ', '통합 로그'] as L5,
  intro: [
    '一次查詢橫跨所有服務的 CloudWatch 日誌(API、引擎、分派器、WebSocket、Runner、系統更新),方便除錯故障。',
    'Search CloudWatch logs across every service at once (API, engine, dispatcher, WebSocket, runners, updates) to debug failures.',
    '一次查询横跨所有服务的 CloudWatch 日志(API、引擎、分派器、WebSocket、Runner、系统更新),方便排错。',
    'すべてのサービスの CloudWatch ログ(API・エンジン・ディスパッチャ・WebSocket・ランナー・更新)を一度に検索して障害を調査できます。',
    '모든 서비스의 CloudWatch 로그(API, 엔진, 디스패처, WebSocket, 러너, 업데이트)를 한 번에 검색해 장애를 디버깅합니다.',
  ] as L5,
  sources: ['服務來源', 'Sources', '服务来源', 'ソース', '소스'] as L5,
  all: ['全部', 'All', '全部', 'すべて', '전체'] as L5,
  none: ['清空', 'None', '清空', 'なし', '없음'] as L5,
  range: ['時間範圍', 'Time range', '时间范围', '期間', '기간'] as L5,
  m15: ['近 15 分', 'Last 15 min', '近 15 分', '直近 15 分', '최근 15분'] as L5,
  h1: ['近 1 小時', 'Last 1 hour', '近 1 小时', '直近 1 時間', '최근 1시간'] as L5,
  h3: ['近 3 小時', 'Last 3 hours', '近 3 小时', '直近 3 時間', '최근 3시간'] as L5,
  d1: ['近 24 小時', 'Last 24 hours', '近 24 小时', '直近 24 時間', '최근 24시간'] as L5,
  keyword: ['關鍵字', 'Keyword', '关键字', 'キーワード', '키워드'] as L5,
  keywordPh: ['只顯示含此文字的行(可留空)', 'Only lines containing this text (optional)', '只显示含此文字的行(可留空)', 'この文字を含む行だけ(任意)', '이 텍스트를 포함한 줄만(선택)'] as L5,
  errorsOnly: ['只看錯誤', 'Errors only', '只看错误', 'エラーのみ', '오류만'] as L5,
  search: ['查詢', 'Search', '查询', '検索', '검색'] as L5,
  searching: ['查詢中…', 'Searching…', '查询中…', '検索中…', '검색 중…'] as L5,
  download: ['下載', 'Download', '下载', 'ダウンロード', '다운로드'] as L5,
  loadingSources: ['載入來源中…', 'Loading sources…', '载入来源中…', 'ソース読み込み中…', '소스 로드 중…'] as L5,
  empty: ['這個範圍沒有符合的日誌', 'No logs match in this range', '这个范围没有符合的日志', 'この範囲に該当するログはありません', '이 범위에 일치하는 로그가 없습니다'] as L5,
  hint: ['選好服務與範圍後按「查詢」。', 'Pick services and a range, then Search.', '选好服务与范围后按「查询」。', 'サービスと期間を選び「検索」を押します。', '서비스와 기간을 선택한 뒤 검색을 누르세요.'] as L5,
  colTime: ['時間', 'Time', '时间', '時刻', '시간'] as L5,
  colSource: ['來源', 'Source', '来源', 'ソース', '소스'] as L5,
  colMessage: ['訊息', 'Message', '消息', 'メッセージ', '메시지'] as L5,
  count: ['{n} 筆', '{n} lines', '{n} 条', '{n} 件', '{n}건'] as L5,
  failed: ['查詢失敗', 'Query failed', '查询失败', 'クエリ失敗', '쿼리 실패'] as L5,
  truncated: ['只顯示最新 {n} 筆', 'Showing newest {n}', '只显示最新 {n} 条', '最新の {n} 件のみ表示', '최신 {n}건만 표시'] as L5,
};

/**
 * 服務來源名稱。後端只回穩定 key(sourceId),顯示文字在這裡決定 ——
 * 原本後端直接回繁中字串、前端照印,所以日文/英文介面的來源晶片與「來源」欄都是中文。
 */
const SRC: Record<LogSourceId, L5> = {
  api: ['控制面 API', 'Control-plane API', '控制面 API', 'コントロールプレーン API', '컨트롤 플레인 API'],
  engine: ['引擎 Engine', 'Engine', '引擎 Engine', 'エンジン', '엔진'],
  dispatcher: ['分派器 Dispatcher', 'Dispatcher', '分派器 Dispatcher', 'ディスパッチャ', '디스패처'],
  'ws-auth': ['WebSocket 授權', 'WebSocket authorizer', 'WebSocket 授权', 'WebSocket 認可', 'WebSocket 권한 부여'],
  'ws-connect': ['WebSocket 連線', 'WebSocket connect', 'WebSocket 连接', 'WebSocket 接続', 'WebSocket 연결'],
  'ws-push': ['WebSocket 推送', 'WebSocket push', 'WebSocket 推送', 'WebSocket プッシュ', 'WebSocket 푸시'],
  'runner-exploration': ['Runner(真機 / Device Farm)', 'Runner (real device / Device Farm)', 'Runner(真机 / Device Farm)', 'ランナー(実機 / Device Farm)', '러너(실기기 / Device Farm)'],
  'runner-web': ['Runner(Web 瀏覽器)', 'Runner (web browser)', 'Runner(Web 浏览器)', 'ランナー(Web ブラウザ)', '러너(웹 브라우저)'],
  update: ['系統更新(CodeBuild)', 'System update (CodeBuild)', '系统更新(CodeBuild)', 'システム更新(CodeBuild)', '시스템 업데이트(CodeBuild)'],
  'image-runner': ['映像建置(真機 runner)', 'Image build (device runner)', '镜像构建(真机 runner)', 'イメージビルド(実機ランナー)', '이미지 빌드(실기기 러너)'],
  'image-web': ['映像建置(web runner)', 'Image build (web runner)', '镜像构建(web runner)', 'イメージビルド(web ランナー)', '이미지 빌드(web 러너)'],
  installer: ['安裝器(CodeBuild)', 'Installer (CodeBuild)', '安装器(CodeBuild)', 'インストーラー(CodeBuild)', '설치 프로그램(CodeBuild)'],
  'log-retention': ['其他(log 保留設定)', 'Other (log retention)', '其他(log 保留设置)', 'その他(ログ保持設定)', '기타(로그 보존 설정)'],
  's3-events': ['其他(S3 事件)', 'Other (S3 events)', '其他(S3 事件)', 'その他(S3 イベント)', '기타(S3 이벤트)'],
  'custom-resource': ['其他(自訂資源)', 'Other (custom resources)', '其他(自定义资源)', 'その他(カスタムリソース)', '기타(사용자 지정 리소스)'],
  'lambda-other': ['其他 Lambda', 'Other Lambda', '其他 Lambda', 'その他の Lambda', '기타 Lambda'],
  other: ['其他', 'Other', '其他', 'その他', '기타'],
};

const RANGES: { key: keyof typeof S; minutes: number }[] = [
  { key: 'm15', minutes: 15 },
  { key: 'h1', minutes: 60 },
  { key: 'h3', minutes: 180 },
  { key: 'd1', minutes: 1440 },
];
const MAX_RENDER = 1000;
const POLL_MS = 1300;
const POLL_LIMIT = 40; // ~52s 上限,避免卡死輪詢

/**
 * 系統管理頁的集中日誌面板(admin 專用)。跨服務查 CloudWatch Logs:選來源 + 時間範圍 + 關鍵字,
 * 用 CloudWatch Logs Insights 非同步查詢,啟動後輪詢結果直到完成。
 */
export function LogsPanel() {
  const { locale } = useI18n();
  const lang = loc5(locale);
  const tr = (v: L5) => pick5(v, lang);
  /** 來源顯示名:認得 sourceId 就翻譯,否則退回後端給的字(舊後端 / 未知種類)。 */
  const srcName = (sourceId: LogSourceId | undefined, fallback: string) =>
    (sourceId && SRC[sourceId] ? tr(SRC[sourceId]) : fallback);

  const [sources, setSources] = useState<LogSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minutes, setMinutes] = useState(60);
  const [keyword, setKeyword] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);

  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 載入可查詢來源;預設全選。
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const r = await apiGet<{ items: LogSource[] }>('/system/logs/sources');
        if (stop) return;
        setSources(r.items);
        setSelected(new Set(r.items.map((s) => s.logGroupName)));
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!stop) setSourcesLoading(false);
      }
    })();
    return () => { stop = true; };
  }, []);

  // 卸載時停掉輪詢。
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });

  const search = useCallback(async () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setError(null);
    setBusy(true);
    setRows(null);
    try {
      const picked = sources.filter((s) => selected.has(s.logGroupName)).map((s) => s.logGroupName);
      const started = await apiPost<{ queryId: string }>('/system/logs/query', {
        ...(picked.length > 0 && picked.length < sources.length ? { sources: picked } : {}),
        minutes,
        ...(keyword.trim() ? { pattern: keyword.trim() } : {}),
        limit: MAX_RENDER,
      });
      let tries = 0;
      const poll = async () => {
        tries += 1;
        try {
          const res = await apiGet<LogQueryResult>(`/system/logs/query/${encodeURIComponent(started.queryId)}`);
          if (res.done) {
            setRows(res.rows);
            setBusy(false);
            if (res.status !== 'Complete') setError(tr(S.failed));
            return;
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setBusy(false);
          return;
        }
        if (tries >= POLL_LIMIT) { setBusy(false); return; }
        pollRef.current = setTimeout(() => void poll(), POLL_MS);
      };
      pollRef.current = setTimeout(() => void poll(), POLL_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [sources, selected, minutes, keyword, locale]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const f = errorsOnly ? rows.filter((r) => r.level === 'ERROR') : rows;
    return f.slice(0, MAX_RENDER);
  }, [rows, errorsOnly]);

  function download() {
    if (!rows || rows.length === 0) return;
    // 下載的檔案跟著介面語系(使用者看到什麼就下載什麼)。
    const text = rows
      .map((r) => `${new Date(r.ts).toISOString()}\t${srcName(r.sourceId, r.source)}\t${r.level ?? ''}\t${r.message}`)
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = `playagent-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const allOn = sources.length > 0 && selected.size === sources.length;

  return (
    <>
      <h2 className="sysupd__section">{tr(S.section)}</h2>
      <div className="sysupd__card">
        <p className="sysupd__hint">{tr(S.intro)}</p>

        {sourcesLoading ? (
          <p className="sysupd__muted">{tr(S.loadingSources)}</p>
        ) : (
          <>
            {/* 服務來源 */}
            <div className="syslog__field">
              <div className="syslog__field-head">
                <span className="syslog__label">{tr(S.sources)}</span>
                <button type="button" className="syslog__link" onClick={() => setSelected(allOn ? new Set() : new Set(sources.map((s) => s.logGroupName)))}>
                  {allOn ? tr(S.none) : tr(S.all)}
                </button>
              </div>
              <div className="syslog__chips">
                {sources.map((s) => (
                  <button
                    key={s.logGroupName}
                    type="button"
                    className={`syslog__chip ${selected.has(s.logGroupName) ? 'is-on' : ''}`}
                    data-kind={s.kind}
                    aria-pressed={selected.has(s.logGroupName)}
                    title={s.logGroupName}
                    onClick={() => toggle(s.logGroupName)}
                  >
                    {srcName(s.sourceId, s.label)}
                  </button>
                ))}
              </div>
            </div>

            {/* 時間範圍 + 關鍵字 */}
            <div className="syslog__controls">
              <label className="syslog__inline">
                <span className="syslog__label">{tr(S.range)}</span>
                <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                  {RANGES.map((r) => (
                    <option key={r.minutes} value={r.minutes}>{tr(S[r.key] as L5)}</option>
                  ))}
                </select>
              </label>
              <input
                type="search"
                className="syslog__search"
                value={keyword}
                placeholder={tr(S.keywordPh)}
                aria-label={tr(S.keyword)}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void search(); }}
              />
              <label className="syslog__inline">
                <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
                <span>{tr(S.errorsOnly)}</span>
              </label>
              <span className="syslog__spacer" />
              <button type="button" className="sysupd__primary" disabled={busy || selected.size === 0} onClick={() => void search()}>
                {busy ? tr(S.searching) : tr(S.search)}
              </button>
              <button type="button" className="syslog__btn" disabled={!rows || rows.length === 0} onClick={download}>
                {tr(S.download)}
              </button>
            </div>

            {error && <p className="sysupd__error" role="alert">{error}</p>}

            {/* 結果 */}
            {rows === null ? (
              <p className="sysupd__muted">{tr(S.hint)}</p>
            ) : shown.length === 0 ? (
              <p className="sysupd__muted">{tr(S.empty)}</p>
            ) : (
              <>
                <p className="syslog__count">
                  {tr(S.count).replace('{n}', String(shown.length))}
                  {rows.length > MAX_RENDER ? ` · ${tr(S.truncated).replace('{n}', String(MAX_RENDER))}` : ''}
                </p>
                <div className="syslog__log" role="log" tabIndex={0}>
                  {shown.map((r, idx) => (
                    <div key={`${r.ts}-${idx}`} className={`syslog__line ${r.level ? `is-${r.level}` : ''}`}>
                      <span className="syslog__t">{hms(r.ts)}</span>
                      <span className="syslog__src" title={r.logGroup}>{srcName(r.sourceId, r.source)}</span>
                      {r.level && <span className={`syslog__lv is-${r.level}`}>{r.level}</span>}
                      <span className="syslog__msg">{r.message}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function hms(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString(undefined, { hour12: false })}`;
}
