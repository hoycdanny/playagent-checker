import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '../../api/client.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { reportLang, type RLang } from '../report/reportText.ts';
import { formatPick, gestureBody, type PickPoint } from './LivePlayer.tsx';
import './OperatorChat.css';

/** 只點 / 只拖、沒打字時後端填的預設文字(infra/lambda/api/operatorCommands.ts)。 */
const POINT_ONLY_TEXT = '點這個位置';
const DRAG_ONLY_TEXT = '照這條路徑拖曳';

/** 後端 GET /tasks/{id}/commands 的一則(infra/lambda/api/operatorCommands.ts)。 */
interface CommandView {
  id: string;
  text: string;
  createdAt: string;
  createdBy?: string;
  screen?: string;
  hintId?: string;
  point?: { x: number; y: number };
  /** 拖曳終點(有就代表「從 point 拖到 to」)。 */
  to?: { x: number; y: number };
  dragMs?: number;
  ack?: { status: 'received' | 'applied'; step?: number; reply?: string; action?: string; screen?: string; at?: string; direct?: boolean; device?: { x: number; y: number; x2?: number; y2?: number } };
}

const T = {
  title: ['與控制遊戲 Agent 互動', 'Interact with the game-control Agent'],
  hint: ['在即時畫面上點一下 / 拖一下 = 直接在裝置上操作(不經 AI,馬上執行),並把座標告訴控制遊戲 Agent。打字 = 告訴 Agent 該怎麼做(例如「點右下方的 SPIN 按鈕開始轉」),它下一步照做。', 'Click or drag on the live screen = operate the device directly (no AI, runs right away); the coordinates are passed to the game-control Agent. Type = tell the Agent what to do (e.g. “tap the SPIN button at the bottom right”); it follows on its next step.'],
  placeholder: ['輸入指令… (Enter 送出,Shift+Enter 換行)', 'Type an instruction… (Enter to send, Shift+Enter for a new line)'],
  send: ['送出', 'Send'],
  sending: ['送出中…', 'Sending…'],
  remember: ['記住到這個應用的記憶(下次測試 AI 一開始就知道)', 'Remember for this app (the AI will know it on future runs)'],
  remembered: ['已記住', 'Remembered'],
  pending: ['等待控制遊戲 Agent 讀取…', 'Waiting for the Agent’s next step…'],
  pendingGesture: ['等待執行…', 'Running…'],
  received: ['Agent 已收到(第 {n} 步)', 'Received by the Agent (step {n})'],
  applied: ['Agent 第 {n} 步回應', 'Agent response at step {n}'],
  direct: ['已直接在裝置上執行', 'Executed directly on the device'],
  deviceAt: ['裝置座標 {p}', 'device {p}'],
  ended: ['測試已結束,無法再下指令。', 'The run has ended; no more instructions.'],
  empty: ['還沒有指令。', 'No instructions yet.'],
  you: ['你', 'You'],
  ai: ['Agent', 'Agent'],
  engine: ['裝置', 'Device'],
  error: ['送出失敗:', 'Failed to send: '],
  onScreen: ['畫面', 'screen'],
  memoryLink: ['管理應用記憶', 'Manage app memory'],
  examples: ['範例', 'Examples'],
  pointChip: ['已選畫面位置 {p} · 送出後直接在裝置上點這裡', 'Screen position {p} selected · tapped on the device right away when you send'],
  pointPlaceholder: ['說明這個位置(可留空),例如「這是 SPIN,以後都點這」', 'Describe this spot (optional), e.g. “this is SPIN”'],
  pointOnly: ['點這個位置', 'Tap this spot'],
  dragChip: ['已選拖曳路徑 {p} · 送出後直接在裝置上照這樣拖', 'Drag path {p} selected · dragged on the device right away when you send'],
  dragPlaceholder: ['說明這個拖曳(可留空),例如「把寶石拖到右邊的格子」', 'Describe this drag (optional), e.g. “drag the gem to the right slot”'],
  dragOnly: ['照這條路徑拖曳', 'Drag along this path'],
  clearPoint: ['取消選取的位置', 'Clear the selected position'],
  pickTip: ['小技巧:開啟即時畫面的指定模式,點一下可指定位置,按住拖曳可指定拖曳路徑。', 'Tip: turn on pick mode on the live screen — click for an exact spot, press and drag for a drag path.'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];
const EXAMPLES: Record<RLang, string[]> = {
  zh: ['點右下方的 SPIN 按鈕開始轉', '先關掉中間的公告彈窗(右上角 X)', '不要點左邊的商店,往右邊走'],
  en: ['Tap the SPIN button at the bottom right', 'Close the notice popup first (X at top right)', 'Don’t open the shop on the left; go right'],
};

/**
 * 測試中的即時指令聊天室。送出 → POST /tasks/{id}/commands;每 2 秒輪詢回執(AI 收到/回應)。
 * 預設勾「記住」:指令同時寫進這個應用的記憶(記憶地圖可編修)。
 */
export function OperatorChat({ jobId, isLive, currentScreen, appId, point, onClearPoint, refreshKey }: {
  jobId: string;
  isLive: boolean;
  currentScreen?: string;
  appId?: string;
  /** 在即時畫面上選的位置(或拖曳路徑):送出時一起帶上,runner 直接照做。 */
  point?: PickPoint | null;
  onClearPoint?: () => void;
  /** 外部(例:畫面上的「讓 AI 點這裡」)送出指令後遞增,觸發立即重抓。 */
  refreshKey?: number;
}) {
  const { locale } = useI18n();
  const lang = reportLang(locale);
  const [items, setItems] = useState<CommandView[]>([]);
  const [text, setText] = useState('');
  const [remember, setRemember] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ items: CommandView[] }>(`/tasks/${jobId}/commands`);
      setItems(r.items);
    } catch { /* 暫時失敗:保留現有 */ }
  }, [jobId]);

  useEffect(() => {
    void load();
    // 執行中、或還有「尚未回應」的指令時持續輪詢。
    if (!isLive && items.every((c) => c.ack?.status === 'applied')) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, isLive, items.length, items.filter((c) => c.ack?.status === 'applied').length]);

  useEffect(() => {
    if (refreshKey) void load();
  }, [refreshKey, load]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, items.map((c) => c.ack?.status).join()]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if ((!t && !point) || sending || !isLive) return;
    setSending(true);
    setError(null);
    try {
      const cmd = await apiPost<CommandView>(`/tasks/${jobId}/commands`, {
        ...(t ? { text: t } : {}),
        remember,
        ...(currentScreen ? { screen: currentScreen } : {}),
        ...(point ? gestureBody(point) : {}),
      });
      setItems((prev) => [...prev, cmd]);
      setText('');
      onClearPoint?.();
    } catch (err) {
      setError(`${tx('error', lang)}${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

  return (
    <section className="opchat" aria-label={tx('title', lang)}>
      <header className="opchat__head">
        <h3 className="opchat__title">{tx('title', lang)}</h3>
        {appId && <Link to={`/memory?app=${encodeURIComponent(appId)}`} className="opchat__memlink">{tx('memoryLink', lang)} →</Link>}
      </header>
      <p className="opchat__hint">{tx('hint', lang)}</p>

      <ol className="opchat__list" ref={listRef} aria-live="polite">
        {items.length === 0 && <li className="opchat__empty">{tx('empty', lang)}</li>}
        {items.map((c) => (
          <li key={c.id} className="opchat__item">
            <div className="opchat__msg opchat__msg--you">
              <div className="opchat__meta">
                <span>{tx('you', lang)}</span>
                <span>{time(c.createdAt)}</span>
                {c.screen && <span className="opchat__screen">{tx('onScreen', lang)}:{c.screen}</span>}
                {c.hintId && <span className="opchat__tag">{tx('remembered', lang)}</span>}
              </div>
              <p>
                {c.point && <span className="opchat__pin">{c.to ? '↗' : '📍'} {formatPick({ ...c.point, to: c.to })} </span>}
                {c.point && c.text === POINT_ONLY_TEXT ? tx('pointOnly', lang)
                  : c.point && c.text === DRAG_ONLY_TEXT ? tx('dragOnly', lang)
                  : c.text}
              </p>
            </div>
            <div className={`opchat__msg opchat__msg--ai ${c.ack?.status === 'applied' ? 'is-done' : 'is-wait'}`}>
              <div className="opchat__meta">
                <span>{c.ack?.direct ? tx('engine', lang) : tx('ai', lang)}</span>
                {c.ack?.at && <span>{time(c.ack.at)}</span>}
                {c.ack?.action && <span className="opchat__tag opchat__tag--action">{c.ack.action}</span>}
              </div>
              {!c.ack ? (
                <p className="opchat__status"><span className="opchat__dots" aria-hidden="true" />{tx(c.point ? 'pendingGesture' : 'pending', lang)}</p>
              ) : c.ack.status === 'received' ? (
                <p className="opchat__status"><span className="opchat__dots" aria-hidden="true" />{tx('received', lang).replace('{n}', String(c.ack.step ?? '?'))}</p>
              ) : (
                <>
                  <p className="opchat__status">
                    {c.ack.direct
                      ? `${tx('direct', lang)}${c.ack.device ? ` · ${tx('deviceAt', lang).replace('{p}', c.ack.device.x2 !== undefined ? `(${c.ack.device.x}, ${c.ack.device.y}) → (${c.ack.device.x2}, ${c.ack.device.y2})` : `(${c.ack.device.x}, ${c.ack.device.y})`)}` : ''}`
                      : `${tx('applied', lang).replace('{n}', String(c.ack.step ?? '?'))}${c.ack.screen ? ` · ${c.ack.screen}` : ''}`}
                  </p>
                  {c.ack.reply && <p className="opchat__reply">{c.ack.reply}</p>}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>

      {isLive ? (
        <form className="opchat__form" onSubmit={send}>
          {point && (
            <div className="opchat__point" role="status">
              <span>{tx(point.to ? 'dragChip' : 'pointChip', lang).replace('{p}', formatPick(point))}</span>
              <button type="button" className="opchat__point-x" onClick={onClearPoint} aria-label={tx('clearPoint', lang)}>✕</button>
            </div>
          )}
          <label className="visually-hidden" htmlFor={`opchat-${jobId}`}>{tx('title', lang)}</label>
          <textarea
            id={`opchat-${jobId}`}
            className="opchat__input"
            rows={2}
            maxLength={500}
            value={text}
            placeholder={point ? tx(point.to ? 'dragPlaceholder' : 'pointPlaceholder', lang) : tx('placeholder', lang)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="opchat__row">
            <label className="opchat__remember">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              {tx('remember', lang)}
            </label>
            <button type="submit" className="opchat__send" disabled={sending || (!text.trim() && !point)}>
              {sending ? tx('sending', lang) : tx('send', lang)}
            </button>
          </div>
          {!point && items.length === 0 && <p className="opchat__tip">{tx('pickTip', lang)}</p>}
          {!text && items.length === 0 && (
            <div className="opchat__examples" aria-label={tx('examples', lang)}>
              {EXAMPLES[lang].map((ex) => (
                <button key={ex} type="button" className="opchat__example" onClick={() => setText(ex)}>{ex}</button>
              ))}
            </div>
          )}
          {error && <p className="opchat__error" role="alert">{error}</p>}
        </form>
      ) : (
        <p className="opchat__ended">{tx('ended', lang)}</p>
      )}
    </section>
  );
}
