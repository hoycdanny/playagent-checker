import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { InfoIcon } from './InfoIcon.tsx';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '../../api/client.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { loc5, pick5, type L5 } from '../../i18n/locale5.ts';
import { reportLang, type RLang } from '../report/reportText.ts';
import { formatPick, gestureBody, type PickPoint } from './LivePlayer.tsx';
import './OperatorChat.css';

/** 只點 / 只拖、沒打字時後端填的預設文字(infra/lambda/api/operatorCommands.ts)。 */
// i18n-allow: matches the default texts the backend stores for point-only / drag-only commands
const POINT_ONLY_TEXT = '點這個位置',
  DRAG_ONLY_TEXT = '照這條路徑拖曳';

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
  title: ['與控制遊戲 Agent 互動', 'Interact with the game-control Agent', '与控制游戏 Agent 交互', 'ゲーム操作エージェントとやり取りする', '게임 제어 에이전트와 상호작용'],
  hint: ['在即時畫面上點一下 / 拖一下 = 直接在裝置上操作(不經 AI,馬上執行),並把座標告訴控制遊戲 Agent。打字 = 告訴 Agent 該怎麼做(例如「點右下方的 SPIN 按鈕開始轉」),它下一步照做。', 'Click or drag on the live screen = operate the device directly (no AI, runs right away); the coordinates are passed to the game-control Agent. Type = tell the Agent what to do (e.g. “tap the SPIN button at the bottom right”); it follows on its next step.', '在即时画面上点一下 / 拖一下 = 直接在设备上操作(不经 AI,马上运行),并把座标告诉控制游戏 Agent。打字 = 告诉 Agent 该怎么做(例如「点右下方的 SPIN 按钮开始转」),它下一步照做。', 'ライブ画面でクリック / ドラッグ = デバイスを直接操作(AI を介さず即実行)し、座標をゲーム操作エージェントに伝えます。入力 = エージェントにやることを伝える(例:「右下の SPIN ボタンを押して回して」)と、次のステップでその通りに動きます。', '실시간 화면에서 클릭 / 드래그 = 기기를 직접 조작(AI를 거치지 않고 즉시 실행)하고 좌표를 게임 제어 에이전트에게 전달합니다. 입력 = 에이전트에게 할 일을 알려 줌(예: \'오른쪽 아래 SPIN 버튼을 눌러 돌려 줘\'), 다음 단계에서 그대로 수행합니다.'],
  placeholder: ['輸入指令… (Enter 送出,Shift+Enter 換行)', 'Type an instruction… (Enter to send, Shift+Enter for a new line)', '输入指令… (Enter 送出,Shift+Enter 换行)', '指示を入力… (Enter で送信、Shift+Enter で改行)', '지시를 입력하세요… (Enter로 전송, Shift+Enter로 줄바꿈)'],
  send: ['送出', 'Send', '送出', '送信', '전송'],
  sending: ['送出中…', 'Sending…', '送出中…', '送信中…', '전송하는 중…'],
  remember: ['記住到這個應用的記憶(下次測試 AI 一開始就知道)', 'Remember for this app (the AI will know it on future runs)', '记住到这个应用的记忆(下次测试 AI 一开始就知道)', 'このアプリのメモリに記憶する(次回以降のテストで AI が最初から把握)', '이 앱의 메모리에 기억하기(다음 테스트부터 AI가 처음부터 알고 있음)'],
  remembered: ['已記住', 'Remembered', '已记住', '記憶しました', '기억함'],
  pending: ['等待控制遊戲 Agent 讀取…', 'Waiting for the Agent’s next step…', '等待控制游戏 Agent 读取…', 'ゲーム操作エージェントの読み取りを待機中…', '게임 제어 에이전트가 읽기를 기다리는 중…'],
  pendingGesture: ['等待執行…', 'Running…', '等待运行…', '実行待ち…', '실행 대기 중…'],
  received: ['Agent 已收到(第 {n} 步)', 'Received by the Agent (step {n})', 'Agent 已收到(第 {n} 步)', 'エージェントが受信しました(ステップ {n})', '에이전트가 받았습니다({n}단계)'],
  applied: ['Agent 第 {n} 步回應', 'Agent response at step {n}', 'Agent 第 {n} 步回应', 'エージェントのステップ {n} の応答', '에이전트의 {n}단계 응답'],
  direct: ['已直接在裝置上執行', 'Executed directly on the device', '已直接在设备上运行', 'デバイス上で直接実行しました', '기기에서 바로 실행했습니다'],
  deviceAt: ['裝置座標 {p}', 'device {p}', '设备座标 {p}', 'デバイス座標 {p}', '기기 좌표 {p}'],
  ended: ['測試已結束,無法再下指令。', 'The run has ended; no more instructions.', '测试已结束,无法再下指令。', 'テストは終了したため、これ以上指示を出せません。', '테스트가 종료되어 더 이상 지시할 수 없습니다.'],
  empty: ['還沒有指令。', 'No instructions yet.', '还没有指令。', '指示はまだありません。', '아직 지시가 없습니다.'],
  you: ['你', 'You', '你', 'あなた', '나'],
  ai: ['Agent', 'Agent', 'Agent', 'エージェント', '에이전트'],
  engine: ['裝置', 'Device', '设备', 'デバイス', '기기'],
  error: ['送出失敗:', 'Failed to send: ', '送出失败:', '送信に失敗しました:', '전송하지 못했습니다:'],
  onScreen: ['畫面', 'screen', '画面', '画面', '화면'],
  memoryLink: ['管理應用記憶', 'Manage app memory', '管理应用记忆', 'アプリメモリを管理', '앱 메모리 관리'],
  examples: ['範例', 'Examples', '范例', '例', '예시'],
  pointChip: ['已選畫面位置 {p} · 送出後直接在裝置上點這裡', 'Screen position {p} selected · tapped on the device right away when you send', '已选画面位置 {p} · 送出后直接在设备上点这里', '画面位置 {p} を選択済み · 送信するとデバイス上のここを直接タップします', '화면 위치 {p} 선택됨 · 전송하면 기기에서 바로 여기를 탭합니다'],
  pointPlaceholder: ['說明這個位置(可留空),例如「這是 SPIN,以後都點這」', 'Describe this spot (optional), e.g. “this is SPIN”', '说明这个位置(可留空),例如「这是 SPIN,以后都点这」', 'この位置を説明(空欄可)。例:「これは SPIN、今後はここをタップ」', '이 위치를 설명하세요(비워도 됨). 예: \'이것은 SPIN이니 앞으로 여기를 누르세요\''],
  pointOnly: ['點這個位置', 'Tap this spot', '点这个位置', 'この位置をタップ', '이 위치를 탭'],
  dragChip: ['已選拖曳路徑 {p} · 送出後直接在裝置上照這樣拖', 'Drag path {p} selected · dragged on the device right away when you send', '已选拖曳路径 {p} · 送出后直接在设备上照这样拖', 'ドラッグ経路 {p} を選択済み · 送信するとデバイス上でこのとおりにドラッグします', '드래그 경로 {p} 선택됨 · 전송하면 기기에서 이대로 드래그합니다'],
  dragPlaceholder: ['說明這個拖曳(可留空),例如「把寶石拖到右邊的格子」', 'Describe this drag (optional), e.g. “drag the gem to the right slot”', '说明这个拖曳(可留空),例如「把宝石拖到右边的格子」', 'このドラッグを説明(空欄可)。例:「宝石を右のマスへドラッグ」', '이 드래그를 설명하세요(비워도 됨). 예: \'보석을 오른쪽 칸으로 끌어 놓기\''],
  dragOnly: ['照這條路徑拖曳', 'Drag along this path', '照这条路径拖曳', 'この経路でドラッグ', '이 경로로 드래그'],
  clearPoint: ['取消選取的位置', 'Clear the selected position', '取消选取的位置', '選択した位置を解除', '선택한 위치 해제'],
  pickTip: ['小技巧:開啟即時畫面的指定模式,點一下可指定位置,按住拖曳可指定拖曳路徑。', 'Tip: turn on pick mode on the live screen — click for an exact spot, press and drag for a drag path.', '小技巧:打开即时画面的指定模式,点一下可指定位置,按住拖曳可指定拖曳路径。', 'ヒント:ライブ画面で指定モードをオンにすると、クリックで位置、ドラッグでドラッグ経路を指定できます。', '팁: 실시간 화면에서 지정 모드를 켜면 클릭으로 위치를, 드래그로 드래그 경로를 지정할 수 있습니다.'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => pick5(T[k], lang);
const EXAMPLES: readonly L5[] = [
  ['點右下方的 SPIN 按鈕開始轉', 'Tap the SPIN button at the bottom right', '点右下方的 SPIN 按钮开始转', '右下の SPIN ボタンをタップして回す', '오른쪽 아래의 SPIN 버튼을 눌러 돌리기'],
  ['先關掉中間的公告彈窗(右上角 X)', 'Close the notice popup first (X at top right)', '先关掉中间的公告弹窗(右上角 X)', '先に中央のお知らせポップアップを閉じる(右上の X)', '먼저 가운데 공지 팝업을 닫기(오른쪽 위 X)'],
  ['不要點左邊的商店,往右邊走', 'Don’t open the shop on the left; go right', '不要点左边的商店,往右边走', '左のショップは開かず、右へ進む', '왼쪽 상점은 누르지 말고 오른쪽으로 이동'],
];

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
                {c.point && <span className="opchat__pin">{c.to ? '↗' : <InfoIcon name="pin" size={12} />} {formatPick({ ...c.point, to: c.to })} </span>}
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
              {EXAMPLES.map((v) => pick5(v, loc5(locale))).map((ex) => (
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
