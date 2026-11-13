import { useMemo, useState, type FormEvent } from 'react';
import { apiPost } from '../../api/client.ts';
import type { RLang } from '../report/reportText.ts';
import { PageInfo, deleteEdgeOp, type EditPage, type HintsApi } from './MemoryEditor.tsx';
import { OpStage, type StageMarker } from './OpStage.tsx';
import {
  EDITABLE_KINDS,
  MIN_HITS,
  cleanTarget,
  defaultOp,
  exportFileName,
  findScriptPath,
  generateAppiumScript,
  needsPoint,
  opKey,
  pageOps,
  popupHandlers,
  spinOpOf,
  type MemOp,
  type OpEdit,
  type PageOpItem,
  type ScriptEdge,
  type ScriptPage,
  type ScriptStep,
} from './memoryScript.ts';
import { pick5, type L5 } from '../../i18n/locale5.ts';
import './ScreenStudio.css';

/**
 * 畫面工作區:點記憶關係圖的一個畫面後,在圖下方展開。
 *   左:大張截圖,標出每個操作的位置(可直接拖曳修正、點選新增)。
 *   右:分頁 ——
 *     腳本與操作:從起點走到這裡的每一步 + 這個畫面上可以做的操作(確認 / 停用 / 修正 / 新增 / 刪除)
 *     畫面說明:改名、畫面提示、進出路徑、刪除畫面
 *     Appium 程式碼:依目前的腳本即時產生,可複製 / 下載
 * 這裡改的每一步會同時用在:雲端測試(認得畫面就直接照做)、匯出的 Appium 腳本。
 */

export interface StudioPage extends ScriptPage {
  visitCount: number;
  renamed?: boolean;
  autoName?: string;
}

const T = {
  close: ['關閉', 'Close', '关闭', '閉じる', '닫기'],
  backToMap: ['↑ 回到關係圖', '↑ Back to map', '↑ 回到关系图', '↑ マップに戻る', '↑ 관계도로 돌아가기'],
  root: ['起點', 'Start', '起点', '開始', '시작'],
  loading: ['載入畫面', 'Loading screen', '加载画面', '読み込み画面', '로딩 화면'],
  visits: ['到過 {n} 次', 'Visited {n}×', '到过 {n} 次', '{n} 回訪問', '{n}회 방문'],
  summary: ['{ops} 個操作 · {ready} 個會直接執行 · 腳本 {steps} 步', '{ops} actions · {ready} replayed directly · script {steps} steps', '{ops} 个操作 · {ready} 个会直接运行 · 脚本 {steps} 步', '{ops} 件の操作 · {ready} 件は直接実行 · スクリプト {steps} ステップ', '동작 {ops}개 · {ready}개는 바로 실행 · 스크립트 {steps}단계'],
  summaryNoPath: ['{ops} 個操作 · {ready} 個會直接執行 · 還沒有完整腳本', '{ops} actions · {ready} replayed directly · no full script yet', '{ops} 个操作 · {ready} 个会直接运行 · 还没有完整脚本', '{ops} 件の操作 · {ready} 件は直接実行 · 完全なスクリプトはまだありません', '동작 {ops}개 · {ready}개는 바로 실행 · 아직 전체 스크립트 없음'],
  tabScript: ['腳本與操作', 'Script & actions', '脚本与操作', 'スクリプトと操作', '스크립트 및 동작'],
  tabInfo: ['畫面說明', 'Screen details', '画面说明', '画面の説明', '화면 설명'],
  tabCode: ['Appium 程式碼', 'Appium code', 'Appium 代码', 'Appium コード', 'Appium 코드'],
  howTitle: ['這裡的修改會用在哪裡', 'Where these edits are used', '这里的修改会用在哪里', 'ここでの編集の使われ方', '여기서 한 수정이 쓰이는 곳'],
  how: [
    '「會直接執行」的操作,雲端測試認得畫面就照做(不問 AI,快很多);匯出的 Appium 腳本也照這些步驟。成功 2 次以上且沒失敗會自動啟用,你按「確認」或修正位置會立刻啟用。',
    'Actions marked "replayed" are done directly in cloud runs when the screen is recognised (no AI call, much faster), and the exported Appium script follows the same steps. They turn on after 2+ successes with no failures, or immediately when you confirm or fix them.', '「会直接运行」的操作,云端测试认得画面就照做(不问 AI,快很多);导出的 Appium 脚本也照这些步骤。成功 2 次以上且没失败会自动激活,你按「确认」或修正位置会立刻激活。', '「直接実行」の操作は、クラウドテストで画面を認識するとそのまま実行されます(AI を呼ばないため大幅に高速)。エクスポートする Appium スクリプトも同じ手順になります。2 回以上成功し失敗がなければ自動で有効になり、「確認」を押すか位置を修正すると即座に有効になります。', '\'바로 실행\'으로 표시된 동작은 클라우드 테스트에서 화면을 인식하면 그대로 수행됩니다(AI를 호출하지 않아 훨씬 빠름). 내보낸 Appium 스크립트도 같은 단계를 따릅니다. 2회 이상 성공하고 실패가 없으면 자동으로 켜지며, \'확인\'을 누르거나 위치를 수정하면 즉시 켜집니다.',
  ],
  pathTitle: ['腳本 · 從起點走到這裡', 'Script · from the start to here', '脚本 · 从起点走到这里', 'スクリプト · 開始からここまで', '스크립트 · 시작부터 여기까지'],
  pathRoot: ['這裡就是起點(遊戲開啟後的第一個畫面)。', 'This is the start (first screen after the game opens).', '这里就是起点(游戏打开后的第一个画面)。', 'ここが開始地点です(ゲームを開いた直後の最初の画面)。', '여기가 시작 지점입니다(게임을 연 뒤 첫 화면).'],
  pathNone: [
    '還沒有「從起點走到這裡、而且記得點哪裡」的路徑。讓 AI 跑一次測試走到這個畫面,或在前一個畫面按「新增操作」並指到這裡。',
    'No recorded path with positions from the start to here yet. Run a test that reaches this screen, or use "Add action" on the previous screen and point it here.', '还没有「从起点走到这里、而且记得点哪里」的路径。让 AI 跑一次测试走到这个画面,或在前一个画面按「添加操作」并指到这里。', '開始からここまでの、タップ位置を記録した経路はまだありません。テストを実行してこの画面まで到達させるか、前の画面で「操作を追加」を押してここを指定してください。', '시작부터 여기까지 탭 위치가 기록된 경로가 아직 없습니다. 이 화면까지 도달하는 테스트를 실행하거나, 이전 화면에서 \'동작 추가\'를 눌러 여기를 지정하세요.',
  ],
  stepAt: ['在「{p}」', 'On "{p}"', '在「{p}」', '「{p}」で', '\'{p}\'에서'],
  arrive: ['到達「{p}」', 'Arrive at "{p}"', '到达「{p}」', '「{p}」に到達', '\'{p}\'에 도착'],
  hereTitle: ['在這個畫面上的操作', 'Actions on this screen', '在这个画面上的操作', 'この画面での操作', '이 화면에서의 동작'],
  hereEmpty: ['這個畫面還沒有記錄到操作。可以按「新增操作」自己加。', 'No actions recorded on this screen yet. Use "Add action" to create one.', '这个画面还没有记录到操作。可以按「添加操作」自己加。', 'この画面ではまだ操作が記録されていません。「操作を追加」で自分で追加できます。', '이 화면에는 아직 기록된 동작이 없습니다. \'동작 추가\'로 직접 추가할 수 있습니다.'],
  add: ['+ 新增操作', '+ Add action', '+ 添加操作', '+ 操作を追加', '+ 동작 추가'],
  addTitle: ['新增操作', 'Add an action', '添加操作', '操作を追加', '동작 추가'],
  addKind: ['動作', 'Action', '动作', 'アクション', '동작'],
  addName: ['名稱(按鈕上的字)', 'Name (text on the button)', '名称(按钮上的字)', '名前(ボタン上の文字)', '이름(버튼에 적힌 글자)'],
  addNamePh: ['例:SPIN、PLAY、關閉 X', 'e.g. SPIN, PLAY, Close X', '例:SPIN、PLAY、关闭 X', '例:SPIN、PLAY、閉じる X', '예: SPIN, PLAY, 닫기 X'],
  addResult: ['做完之後', 'Afterwards', '做完之后', '実行後', '실행 후'],
  addSelf: ['留在這個畫面(例如 SPIN、下注)', 'Stays on this screen (e.g. SPIN, bet)', '留在这个画面(例如 SPIN、下注)', 'この画面に留まる(例:SPIN、ベット)', '이 화면에 머무름(예: SPIN, 베팅)'],
  addTo: ['會到「{p}」', 'Goes to "{p}"', '会到「{p}」', '「{p}」へ移動', '\'{p}\'(으)로 이동'],
  addPick: ['在左邊的截圖上點一下位置', 'Click the spot on the screenshot', '在左边的截图上点一下位置', '左のスクリーンショット上で位置をクリック', '왼쪽 스크린샷에서 위치를 클릭하세요'],
  addPicked: ['位置 {x}%、{y}%(可在截圖上拖曳調整)', 'At {x}%, {y}% (drag on the screenshot to adjust)', '位置 {x}%、{y}%(可在截图上拖曳调整)', '位置 {x}%、{y}%(スクリーンショット上でドラッグして調整可能)', '위치 {x}%, {y}%(스크린샷에서 드래그하여 조정 가능)'],
  addSave: ['新增', 'Add', '添加', '追加', '추가'],
  addNeedName: ['請填名稱', 'Enter a name', '请填名称', '名前を入力してください', '이름을 입력하세요'],
  addNeedPoint: ['請在截圖上點位置', 'Pick a spot on the screenshot', '请在截图上点位置', 'スクリーンショット上で位置を選択してください', '스크린샷에서 위치를 선택하세요'],
  addNeedText: ['請填要輸入的文字', 'Enter the text to type', '请填要输入的文本', '入力するテキストを入力してください', '입력할 텍스트를 입력하세요'],
  cancel: ['取消', 'Cancel', '取消', 'キャンセル', '취소'],
  sameScreen: ['同一畫面', 'Same screen', '同一画面', '同じ画面', '같은 화면'],
  verified: ['✔ 已確認 · 會直接執行', '✔ Confirmed · replayed', '✔ 已确认 · 会直接运行', '✔ 確認済み · 直接実行', '✔ 확인됨 · 바로 실행'],
  auto: ['⚡ 會直接執行(成功 {n} 次)', '⚡ Replayed ({n} successes)', '⚡ 会直接运行(成功 {n} 次)', '⚡ 直接実行(成功 {n} 回)', '⚡ 바로 실행(성공 {n}회)'],
  learning: ['學習中 {n}/{min}', 'Learning {n}/{min}', '学习中 {n}/{min}', '学習中 {n}/{min}', '학습 중 {n}/{min}'],
  learningMiss: ['學習中 · 有失敗紀錄,需要確認', 'Learning · has failures, needs confirming', '学习中 · 有失败纪录,需要确认', '学習中 · 失敗の記録があり、確認が必要', '학습 중 · 실패 기록이 있어 확인 필요'],
  disabled: ['已停用', 'Disabled', '已停用', '無効', '사용 안 함'],
  noOp: ['沒有位置紀錄(舊資料),請重新指定', 'No position recorded (older data); set one', '没有位置纪录(旧数据),请重新指定', '位置の記録がありません(旧データ)。再指定してください', '위치 기록이 없습니다(이전 데이터). 다시 지정하세요'],
  record: ['成功 {h} · 失敗 {m}', '{h} ok · {m} failed', '成功 {h} · 失败 {m}', '成功 {h} · 失敗 {m}', '성공 {h} · 실패 {m}'],
  manual: ['手動新增', 'Added by you', '手动添加', '手動追加', '직접 추가'],
  edited: ['已修正', 'Edited', '已修正', '修正済み', '수정됨'],
  version: ['錄製版本 {v}', 'Recorded on {v}', '录制版本 {v}', '記録バージョン {v}', '녹화 버전 {v}'],
  confirm: ['確認', 'Confirm', '确认', '確認', '확인'],
  unconfirm: ['取消確認', 'Unconfirm', '取消确认', '確認を取り消す', '확인 취소'],
  disable: ['停用', 'Disable', '停用', '無効にする', '사용 안 함'],
  enable: ['啟用', 'Enable', '激活', '有効にする', '사용'],
  repick: ['重新指定位置', 'Set position again', '重新指定位置', '位置を再指定', '위치 다시 지정'],
  repickBar: ['點截圖上的正確位置…(Esc 取消)', 'Click the right spot on the screenshot… (Esc to cancel)', '点截图上的正确位置…(Esc 取消)', 'スクリーンショット上の正しい位置をクリック…(Esc でキャンセル)', '스크린샷에서 올바른 위치를 클릭하세요… (Esc로 취소)'],
  reset: ['還原 AI 記錄', 'Restore AI recording', '还原 AI 记录', 'AI の記録に戻す', 'AI 기록으로 되돌리기'],
  remove: ['刪除', 'Delete', '删除', '削除', '삭제'],
  removeConfirm: ['刪除這個操作?', 'Delete this action?', '删除这个操作?', 'この操作を削除しますか?', '이 동작을 삭제하시겠습니까?'],
  saveEdits: ['儲存修改', 'Save changes', '保存修改', '変更を保存', '변경 사항 저장'],
  discard: ['放棄', 'Discard', '放弃', '破棄', '취소'],
  startX: ['起點 X %', 'Start X %', '起点 X %', '開始 X %', '시작 X %'],
  startY: ['起點 Y %', 'Start Y %', '起点 Y %', '開始 Y %', '시작 Y %'],
  endX: ['終點 X %', 'End X %', '终点 X %', '終了 X %', '종료 X %'],
  endY: ['終點 Y %', 'End Y %', '终点 Y %', '終了 Y %', '종료 Y %'],
  posX: ['X %', 'X %', 'X %', 'X %', 'X %'],
  posY: ['Y %', 'Y %', 'Y %', 'Y %', 'Y %'],
  holdMs: ['按住(毫秒)', 'Hold (ms)', '按住(毫秒)', '長押し(ミリ秒)', '길게 누르기(밀리초)'],
  swipeMs: ['滑動時間(毫秒)', 'Duration (ms)', '滑动时间(毫秒)', 'スワイプ時間(ミリ秒)', '스와이프 시간(밀리초)'],
  text: ['要輸入的文字', 'Text to type', '要输入的文本', '入力するテキスト', '입력할 텍스트'],
  textHint: ['帳密請寫 ${password} 這種形式,會讀 App 憑證,不要寫真的密碼', 'Use ${password} style placeholders for credentials; never type the real password', '账密请写 ${password} 这种形式,会读 App 凭证,不要写真的密码', '認証情報は ${password} の形式で書いてください。App の認証情報が読み込まれます。実際のパスワードは書かないでください', '계정 정보는 ${password} 형식으로 작성하세요. 앱 자격 증명을 읽어 옵니다. 실제 비밀번호는 쓰지 마세요'],
  key: ['按鍵(enter、tab、space…)', 'Key (enter, tab, space…)', '按键(enter、tab、space…)', 'キー(enter、tab、space…)', '키(enter, tab, space…)'],
  times: ['次數', 'Times', '次数', '回数', '횟수'],
  saved: ['已儲存', 'Saved', '已保存', '保存しました', '저장됨'],
  failed: ['操作失敗:', 'Failed: ', '操作失败:', '操作に失敗しました:', '작업 실패:'],
  codeNone: ['還沒有從起點到這裡的腳本,先在「腳本與操作」補齊路徑。', 'No script from the start to here yet; complete the path under "Script & actions".', '还没有从起点到这里的脚本,先在「脚本与操作」补齐路径。', '開始からここまでのスクリプトがまだありません。まず「スクリプトと操作」で経路を補ってください。', '시작부터 여기까지의 스크립트가 아직 없습니다. 먼저 \'스크립트 및 동작\'에서 경로를 채워 주세요.'],
  codeIntro: [
    '依目前的腳本即時產生;在「腳本與操作」改步驟,這裡會跟著更新。在你的電腦用 Appium 執行:',
    'Generated live from the current script; edit steps under "Script & actions" and this updates. Run it with Appium on your machine:', '依目前的脚本即时产生;在「脚本与操作」改步骤,这里会跟着更新。在你的电脑用 Appium 运行:', '現在のスクリプトからリアルタイムで生成されます。「スクリプトと操作」で手順を編集すると、ここも更新されます。お使いのパソコンで Appium により実行します:', '현재 스크립트에서 실시간으로 생성됩니다. \'스크립트 및 동작\'에서 단계를 수정하면 여기도 갱신됩니다. 내 컴퓨터에서 Appium으로 실행하세요:',
  ],
  copy: ['複製', 'Copy', '复制', 'コピー', '복사'],
  copied: ['已複製', 'Copied', '已复制', 'コピーしました', '복사됨'],
  download: ['下載 .mjs', 'Download .mjs', '下载 .mjs', '.mjs をダウンロード', '.mjs 다운로드'],
  spinsNote: ['這個畫面有 SPIN,可加 --spins 100 連轉 100 局(本機只點,不讀數字;RTP 請在平台上跑)。', 'This screen has a SPIN; add --spins 100 to spin 100 rounds (taps only locally; run RTP on the platform).', '这个画面有 SPIN,可加 --spins 100 连转 100 局(本机只点,不读数字;RTP 请在平台上跑)。', 'この画面には SPIN があります。--spins 100 を付けると 100 回連続で回せます(ローカルではタップのみで数値は読み取りません。RTP はプラットフォームで実行してください)。', '이 화면에는 SPIN이 있습니다. --spins 100을 추가하면 100회 연속으로 돌립니다(로컬에서는 탭만 하고 수치는 읽지 않으며, RTP는 플랫폼에서 실행하세요).'],
  act: { tap: ['點擊', 'Tap', '点击', 'タップ', '탭'], hold: ['長按', 'Hold', '长按', '長押し', '길게 누르기'], swipe: ['滑動', 'Swipe', '滑动', 'スワイプ', '스와이프'], back: ['返回鍵', 'Back', '返回键', '戻る', '뒤로'], type: ['輸入文字', 'Type', '输入文本', 'テキスト入力', '텍스트 입력'], key: ['按鍵', 'Key', '按键', 'キー', '키'], move: ['搖桿', 'Joystick', '摇杆', 'ジョイスティック', '조이스틱'] },
} as const;
type Key = Exclude<keyof typeof T, 'act'>;
const tx = (k: Key, lang: RLang, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce<string>((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), pick5(T[k], lang));
const actName = (a: string, lang: RLang) => {
  const v = (T.act as Record<string, L5>)[a];
  return v ? pick5(v, lang) : a;
};
const pct = (v: number | undefined) => Math.round((v ?? 0) * 1000) / 10;
const unit = (s: string) => Math.max(0, Math.min(1, (Number(s) || 0) / 100));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const opLabel = (kind: string, target: string, lang: RLang) => `${actName(kind, lang)}${target ? `「${target}」` : ''}`;
const omit = <V,>(d: Record<string, V>, key: string): Record<string, V> => {
  const next = { ...d };
  delete next[key];
  return next;
};

type Tab = 'script' | 'info' | 'code';

export function ScreenStudio({
  lang,
  appId,
  appName,
  pageId,
  pages,
  edges,
  rootPageId,
  opEdits,
  shots,
  hintsApi,
  onEdited,
  onOpenPage,
  onClose,
  onBackToMap,
}: {
  lang: RLang;
  appId: string;
  appName?: string;
  pageId: string;
  pages: Record<string, StudioPage>;
  edges: ScriptEdge[];
  rootPageId: string | null;
  opEdits: Record<string, OpEdit>;
  shots: Record<string, string>;
  hintsApi: HintsApi;
  onEdited: () => void;
  onOpenPage: (pageId: string) => void;
  onClose: () => void;
  onBackToMap: () => void;
}) {
  const page = pages[pageId];
  const pageName = (id: string) => pages[id]?.name ?? id;
  const [tab, setTab] = useState<Tab>('script');
  const [stageId, setStageId] = useState(pageId);
  const [focus, setFocus] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, MemOp>>({});
  const [repick, setRepick] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | { kind: string; target: string; to: string; op?: MemOp }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const path = useMemo(() => findScriptPath(pages, edges, opEdits, pageId, rootPageId), [pages, edges, opEdits, pageId, rootPageId]);
  const here = useMemo(() => pageOps(pageId, pages, edges, opEdits), [pageId, pages, edges, opEdits]);
  const stageOps = useMemo(() => (stageId === pageId ? here : pageOps(stageId, pages, edges, opEdits)), [stageId, pageId, here, pages, edges, opEdits]);
  const itemOf = (key: string, fromId: string): PageOpItem | undefined =>
    (fromId === pageId ? here : pageOps(fromId, pages, edges, opEdits)).find((x) => x.key === key);
  const opOf = (it: PageOpItem): MemOp | undefined => drafts[it.key] ?? it.op;

  async function send(bodies: Array<Record<string, unknown>>, done?: string) {
    setBusy(true);
    setError(null);
    try {
      for (const b of bodies) await apiPost('/memory/edit', { app: appId, ...b });
      onEdited();
      if (done) { setToast(done); setTimeout(() => setToast(null), 1600); }
      return true;
    } catch (err) {
      setError(`${tx('failed', lang)}${errText(err)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }
  /** 存位置 / 參數(修正 = 測試人員確認過,直接啟用)。 */
  async function saveOp(it: PageOpItem, op: MemOp) {
    const data: MemOp = { ...op, a: it.kind as MemOp['a'] };
    const ok = await send([{ op: 'setOp', key: it.key, opData: data, verified: true }], tx('saved', lang));
    if (ok) setDrafts((d) => omit(d, it.key));
  }
  const setFlag = (it: PageOpItem, flag: { verified?: boolean; disabled?: boolean }) =>
    void send([{ op: 'setOp', key: it.key, ...flag }], tx('saved', lang));
  const resetOp = (it: PageOpItem) => {
    setDrafts((d) => omit(d, it.key));
    void send([{ op: 'clearOp', key: it.key }], tx('saved', lang));
  };
  const removeOp = (it: PageOpItem) => {
    if (!window.confirm(tx('removeConfirm', lang))) return;
    const k = it.key.split('>');
    const edge = edges.find((e) => e.fromPageId === k[0] && e.toPageId === k[1] && e.trigger?.kind === it.kind && (e.trigger?.target ?? '').trim() === it.target);
    const ops: Array<Record<string, unknown>> = [];
    if (it.toPageId && edge) ops.push(deleteEdgeOp(edge));
    if (it.edit) ops.push({ op: 'clearOp', key: it.key });
    if (focus === it.key) setFocus(null);
    void send(ops, tx('saved', lang));
  };

  async function submitAdd(e: FormEvent) {
    e.preventDefault();
    if (!adding) return;
    const target = cleanTarget(adding.target);
    const op = adding.op ?? (needsPoint(adding.kind) ? undefined : defaultOp(adding.kind, 0.5, 0.5));
    if (!target || !op) return;
    const to = adding.to === 'self' ? pageId : adding.to;
    const key = opKey(pageId, to, adding.kind, target);
    const bodies: Array<Record<string, unknown>> = [];
    if (to !== pageId) bodies.push({ op: 'addEdge', fromPageId: pageId, toPageId: to, kind: adding.kind, target });
    bodies.push({ op: 'setOp', key, opData: op, verified: true });
    if (await send(bodies, tx('saved', lang))) { setAdding(null); setFocus(key); }
  }

  // 舞台上的標記:目前顯示的畫面的所有操作(+ 新增中的那一個)。
  const markers: StageMarker[] = stageOps
    .map((it, i) => ({ it, n: i + 1, op: opOf(it) }))
    .filter((x): x is { it: PageOpItem; n: number; op: MemOp } => Boolean(x.op))
    .map(({ it, n, op }) => ({ key: it.key, n, op, trust: it.trust, label: opLabel(it.kind, it.target, lang), active: focus === it.key }));
  if (adding?.op && stageId === pageId) {
    markers.push({ key: '__new', n: stageOps.length + 1, op: adding.op, trust: 'draft', label: opLabel(adding.kind, adding.target, lang), active: true });
  }
  const pickLabel = repick ? tx('repickBar', lang) : adding && needsPoint(adding.kind) && !adding.op ? tx('addPick', lang) : null;

  const onPick = (x: number, y: number) => {
    if (repick) {
      const it = stageOps.find((s) => s.key === repick);
      setRepick(null);
      if (it) {
        const base = opOf(it) ?? defaultOp(it.kind, x, y);
        const next = it.kind === 'swipe' && base.x2 !== undefined
          ? { ...base, x, y, x2: Math.max(0, Math.min(1, (base.x2 ?? x) + x - (base.x ?? x))), y2: Math.max(0, Math.min(1, (base.y2 ?? y) + y - (base.y ?? y))) }
          : { ...base, x, y };
        void saveOp(it, next);
      }
      return;
    }
    if (adding) setAdding({ ...adding, op: defaultOp(adding.kind, x, y) });
  };
  const onMove = (key: string, op: MemOp) => {
    if (key === '__new') { if (adding) setAdding({ ...adding, op }); return; }
    setDrafts((d) => ({ ...d, [key]: op }));
    setFocus(key);
  };
  const onCommit = (key: string, op: MemOp) => {
    if (key === '__new') return;
    const it = stageOps.find((s) => s.key === key);
    if (it) void saveOp(it, op);
  };
  const focusItem = (key: string, fromId: string) => {
    setStageId(fromId);
    setFocus((cur) => (cur === key ? null : key));
    setRepick(null);
  };

  const ready = here.filter((x) => x.op && (x.trust === 'verified' || x.trust === 'auto')).length;
  const summary = path
    ? tx('summary', lang, { ops: here.length, ready, steps: path.length })
    : tx('summaryNoPath', lang, { ops: here.length, ready });
  const stagePage = pages[stageId];

  const cardProps = { lang, busy, pageName, onOpenPage, saveOp, setFlag, resetOp, removeOp, setDrafts, setRepick, repick };

  if (!page) return null;
  const editPage: EditPage = {
    id: page.id,
    name: page.name,
    visitCount: page.visitCount,
    ...(page.aliases ? { aliases: page.aliases } : {}),
    ...(page.renamed ? { renamed: true } : {}),
    ...(page.autoName ? { autoName: page.autoName } : {}),
  };

  return (
    <section
      className="studio"
      aria-labelledby="studio-title"
      onKeyDown={(e) => { if (e.key === 'Escape' && (repick || adding)) { setRepick(null); setAdding(null); } }}
    >
      <header className="studio__head">
        <div className="studio__titles">
          <h2 id="studio-title" className="studio__title">{page.name}</h2>
          <div className="studio__chips">
            {pageId === rootPageId && <span className="studio__chip studio__chip--root">{tx('root', lang)}</span>}
            {page.transient && <span className="studio__chip">{tx('loading', lang)}</span>}
            <span className="studio__chip">{tx('visits', lang, { n: page.visitCount })}</span>
            <span className="studio__summary">{summary}</span>
          </div>
        </div>
        <div className="studio__head-actions">
          <button type="button" className="studio__ghost" onClick={onBackToMap}>{tx('backToMap', lang)}</button>
          <button type="button" className="studio__close" aria-label={tx('close', lang)} onClick={onClose}>×</button>
        </div>
      </header>

      <div className="studio__tabs" role="tablist" aria-label={page.name}>
        {(['script', 'info', 'code'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`studio-tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`studio-panel-${k}`}
            className={`studio__tab${tab === k ? ' is-active' : ''}`}
            onClick={() => setTab(k)}
          >
            {tx(k === 'script' ? 'tabScript' : k === 'info' ? 'tabInfo' : 'tabCode', lang)}
          </button>
        ))}
        {toast && <span className="studio__toast" role="status">{toast}</span>}
      </div>
      {error && <p className="studio__error" role="alert">{error}</p>}

      {tab === 'code' ? (
        <div id="studio-panel-code" role="tabpanel" aria-labelledby="studio-tab-code">
          <CodeView lang={lang} appId={appId} {...(appName ? { appName } : {})} pageId={pageId} pages={pages} edges={edges} opEdits={opEdits} path={path} />
        </div>
      ) : (
        <div className="studio__body">
          <div className="studio__stage-col">
            {stageId !== pageId && (
              <button type="button" className="studio__stage-back" onClick={() => { setStageId(pageId); setFocus(null); }}>
                ← {pageName(pageId)}
              </button>
            )}
            <p className="studio__stage-name">{stagePage?.name ?? stageId}</p>
            <OpStage
              lang={lang}
              {...(shots[stageId] ? { shotUrl: shots[stageId] } : {})}
              alt={stagePage?.name ?? stageId}
              markers={markers}
              pickLabel={pickLabel}
              onPick={onPick}
              onMove={onMove}
              onCommit={onCommit}
              onSelect={(key) => setFocus(key)}
            />
          </div>

          <div className="studio__side">
            {tab === 'info' ? (
              <div id="studio-panel-info" role="tabpanel" aria-labelledby="studio-tab-info">
                <PageInfo
                  lang={lang}
                  appId={appId}
                  page={editPage}
                  edges={edges}
                  pageName={pageName}
                  api={hintsApi}
                  onDeleted={onClose}
                  onEdited={onEdited}
                  onOpenPage={onOpenPage}
                />
              </div>
            ) : (
              <div id="studio-panel-script" role="tabpanel" aria-labelledby="studio-tab-script">
                <details className="studio__how">
                  <summary>{tx('howTitle', lang)}</summary>
                  <p>{tx('how', lang)}</p>
                </details>

                <h3 className="studio__h3">{tx('pathTitle', lang)}</h3>
                {pageId === rootPageId ? (
                  <p className="studio__muted">{tx('pathRoot', lang)}</p>
                ) : !path ? (
                  <p className="studio__empty">{tx('pathNone', lang)}</p>
                ) : (
                  <ol className="studio__path">
                    {path.map((s, i) => (
                      <PathStep
                        key={s.key}
                        n={i + 1}
                        step={s}
                        shot={shots[s.from.id]}
                        item={itemOf(s.key, s.from.id)}
                        active={focus === s.key}
                        onFocus={() => focusItem(s.key, s.from.id)}
                        card={cardProps}
                        draft={drafts[s.key]}
                      />
                    ))}
                    <li className="studio__arrive">🏁 {tx('arrive', lang, { p: page.name })}</li>
                  </ol>
                )}

                <div className="studio__here-head">
                  <h3 className="studio__h3">{tx('hereTitle', lang)}</h3>
                  {!adding && (
                    <button
                      type="button"
                      className="studio__btn studio__btn--primary"
                      onClick={() => { setStageId(pageId); setFocus(null); setRepick(null); setAdding({ kind: 'tap', target: '', to: 'self' }); }}
                    >
                      {tx('add', lang)}
                    </button>
                  )}
                </div>

                {adding && (
                  <form className="studio__add" onSubmit={(e) => void submitAdd(e)}>
                    <h4>{tx('addTitle', lang)}</h4>
                    <div className="studio__grid2">
                      <label>
                        <span>{tx('addKind', lang)}</span>
                        <select
                          value={adding.kind}
                          onChange={(e) => {
                            const kind = e.target.value;
                            const p = adding.op;
                            // 換動作時保留已點的位置;不需要位置的動作給預設內容。
                            const op = needsPoint(kind)
                              ? (p?.x !== undefined ? defaultOp(kind, p.x, p.y ?? 0.5) : undefined)
                              : defaultOp(kind, 0.5, 0.5);
                            setAdding({ kind, target: adding.target, to: adding.to, ...(op ? { op } : {}) });
                          }}
                        >
                          {EDITABLE_KINDS.map((k) => <option key={k} value={k}>{actName(k, lang)}</option>)}
                        </select>
                      </label>
                      <label>
                        <span>{tx('addName', lang)}</span>
                        <input value={adding.target} maxLength={40} placeholder={tx('addNamePh', lang)} onChange={(e) => setAdding({ ...adding, target: e.target.value })} />
                      </label>
                    </div>
                    <label>
                      <span>{tx('addResult', lang)}</span>
                      <select value={adding.to} onChange={(e) => setAdding({ ...adding, to: e.target.value })}>
                        <option value="self">{tx('addSelf', lang)}</option>
                        {Object.values(pages)
                          .filter((p) => p.id !== pageId)
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map((p) => <option key={p.id} value={p.id}>{tx('addTo', lang, { p: p.name })}</option>)}
                      </select>
                    </label>
                    {adding.kind === 'type' && (
                      <label>
                        <span>{tx('text', lang)}</span>
                        <input value={adding.op?.text ?? ''} maxLength={200} onChange={(e) => setAdding({ ...adding, op: { a: 'type', text: e.target.value } })} />
                        <small>{tx('textHint', lang)}</small>
                      </label>
                    )}
                    {adding.kind === 'key' && (
                      <label>
                        <span>{tx('key', lang)}</span>
                        <input value={adding.op?.key ?? 'enter'} maxLength={16} onChange={(e) => setAdding({ ...adding, op: { a: 'key', key: e.target.value.trim().toLowerCase() } })} />
                      </label>
                    )}
                    {needsPoint(adding.kind) && (
                      <p className={adding.op ? 'studio__muted' : 'studio__pickhint'}>
                        {adding.op ? tx('addPicked', lang, { x: pct(adding.op.x), y: pct(adding.op.y) }) : `👈 ${tx('addPick', lang)}`}
                      </p>
                    )}
                    <div className="studio__actions">
                      <button
                        type="submit"
                        className="studio__btn studio__btn--primary"
                        disabled={busy || !cleanTarget(adding.target) || (needsPoint(adding.kind) && !adding.op) || (adding.kind === 'type' && !adding.op?.text)}
                        title={!cleanTarget(adding.target) ? tx('addNeedName', lang) : needsPoint(adding.kind) && !adding.op ? tx('addNeedPoint', lang) : adding.kind === 'type' && !adding.op?.text ? tx('addNeedText', lang) : undefined}
                      >
                        {tx('addSave', lang)}
                      </button>
                      <button type="button" className="studio__btn" onClick={() => setAdding(null)}>{tx('cancel', lang)}</button>
                    </div>
                  </form>
                )}

                {here.length === 0 && !adding ? (
                  <p className="studio__empty">{tx('hereEmpty', lang)}</p>
                ) : (
                  <ol className="studio__ops">
                    {here.map((it, i) => (
                      <OpCard
                        key={it.key}
                        n={i + 1}
                        item={it}
                        op={opOf(it)}
                        dirty={Boolean(drafts[it.key])}
                        active={focus === it.key}
                        onFocus={() => focusItem(it.key, pageId)}
                        {...cardProps}
                      />
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

interface CardCtx {
  lang: RLang;
  busy: boolean;
  pageName: (id: string) => string;
  onOpenPage: (pageId: string) => void;
  saveOp: (it: PageOpItem, op: MemOp) => Promise<void>;
  setFlag: (it: PageOpItem, flag: { verified?: boolean; disabled?: boolean }) => void;
  resetOp: (it: PageOpItem) => void;
  removeOp: (it: PageOpItem) => void;
  setDrafts: (fn: (d: Record<string, MemOp>) => Record<string, MemOp>) => void;
  setRepick: (key: string | null) => void;
  repick: string | null;
}

function trustText(it: PageOpItem, lang: RLang): string {
  if (!it.op) return tx('noOp', lang);
  if (it.trust === 'verified') return tx('verified', lang);
  if (it.trust === 'auto') return tx('auto', lang, { n: it.hitCount });
  if (it.trust === 'disabled') return tx('disabled', lang);
  return it.missCount > 0 ? tx('learningMiss', lang) : tx('learning', lang, { n: it.hitCount, min: MIN_HITS });
}

/** 腳本的一步(從起點到這裡的路徑上)。 */
function PathStep({ n, step, shot, item, active, onFocus, card, draft }: {
  n: number;
  step: ScriptStep;
  shot?: string | undefined;
  item?: PageOpItem | undefined;
  active: boolean;
  onFocus: () => void;
  card: CardCtx;
  draft?: MemOp | undefined;
}) {
  const { lang } = card;
  return (
    <li className={`studio__step studio__step--${step.trust}${active ? ' is-active' : ''}`}>
      <button type="button" className="studio__step-head" aria-expanded={active} onClick={onFocus}>
        <span className="studio__step-n">{n}</span>
        <span className="studio__step-thumb">{shot ? <img src={shot} alt="" loading="lazy" /> : null}</span>
        <span className="studio__step-text">
          <span className="studio__step-at">{tx('stepAt', lang, { p: step.from.name })}</span>
          <b>{opLabel(step.kind, step.target, lang)}</b>
          <span className="studio__step-to">→ {step.to.name}</span>
        </span>
        <span className={`studio__pill studio__pill--${step.trust}`}>{item ? trustText(item, lang) : ''}</span>
      </button>
      {active && item && <OpEditor item={item} op={draft ?? item.op} dirty={Boolean(draft)} {...card} />}
    </li>
  );
}

/** 這個畫面上的一個操作。 */
function OpCard({ n, item, op, dirty, active, onFocus, ...card }: CardCtx & {
  n: number;
  item: PageOpItem;
  op?: MemOp | undefined;
  dirty: boolean;
  active: boolean;
  onFocus: () => void;
}) {
  const { lang, busy, pageName, onOpenPage, setFlag } = card;
  return (
    <li className={`studio__op studio__op--${item.trust}${active ? ' is-active' : ''}`}>
      <div className="studio__op-head">
        <button type="button" className="studio__op-main" aria-expanded={active} onClick={onFocus}>
          <span className={`studio__num studio__num--${item.trust}`}>{n}</span>
          <span className="studio__op-text">
            <b>{opLabel(item.kind, item.target, lang)}</b>
            <span className="studio__op-meta">
              {trustText(item, lang)}
              {item.manual ? ` · ${tx('manual', lang)}` : ` · ${tx('record', lang, { h: item.hitCount, m: item.missCount })}`}
              {item.edit?.op && !item.manual ? ` · ${tx('edited', lang)}` : ''}
            </span>
          </span>
        </button>
        {item.toPageId ? (
          <button type="button" className="studio__dest" onClick={() => onOpenPage(item.toPageId!)} title={pageName(item.toPageId)}>
            → {pageName(item.toPageId)}
          </button>
        ) : (
          <span className="studio__dest studio__dest--self">{tx('sameScreen', lang)}</span>
        )}
        {!active && item.op && item.trust !== 'verified' && item.trust !== 'disabled' && (
          <button type="button" className="studio__btn studio__btn--small" disabled={busy} onClick={() => setFlag(item, { verified: true })}>{tx('confirm', lang)}</button>
        )}
      </div>
      {active && <OpEditor item={item} op={op} dirty={dirty} {...card} />}
    </li>
  );
}

/** 展開後的編修區:參數、確認 / 停用 / 重新指定 / 還原 / 刪除。 */
function OpEditor({ item, op, dirty, lang, busy, saveOp, setFlag, resetOp, removeOp, setDrafts, setRepick, repick }: CardCtx & {
  item: PageOpItem;
  op?: MemOp | undefined;
  dirty: boolean;
}) {
  const set = (patch: Partial<MemOp>) => setDrafts((d) => ({ ...d, [item.key]: { ...(op ?? defaultOp(item.kind, 0.5, 0.5)), ...patch } as MemOp }));
  const num = (label: string, value: number | undefined, onChange: (v: string) => void, opts: { max?: number; step?: number } = {}) => (
    <label className="studio__field">
      <span>{label}</span>
      <input type="number" min={0} max={opts.max ?? 100} step={opts.step ?? 0.1} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
  const valid = op && (!needsPoint(item.kind) || (op.x !== undefined && op.y !== undefined)) && (item.kind !== 'type' || Boolean(op.text));
  return (
    <div className="studio__editor">
      {op && (item.kind === 'tap' || item.kind === 'hold') && (
        <div className="studio__fields">
          {num(tx('posX', lang), pct(op.x), (v) => set({ x: unit(v) }))}
          {num(tx('posY', lang), pct(op.y), (v) => set({ y: unit(v) }))}
          {item.kind === 'hold' && num(tx('holdMs', lang), op.ms ?? 1000, (v) => set({ ms: Math.max(50, Math.min(10000, Number(v) || 0)) }), { max: 10000, step: 50 })}
        </div>
      )}
      {op && item.kind === 'swipe' && (
        <div className="studio__fields">
          {num(tx('startX', lang), pct(op.x), (v) => set({ x: unit(v) }))}
          {num(tx('startY', lang), pct(op.y), (v) => set({ y: unit(v) }))}
          {num(tx('endX', lang), pct(op.x2), (v) => set({ x2: unit(v) }))}
          {num(tx('endY', lang), pct(op.y2), (v) => set({ y2: unit(v) }))}
          {num(tx('swipeMs', lang), op.ms ?? 300, (v) => set({ ms: Math.max(50, Math.min(10000, Number(v) || 0)) }), { max: 10000, step: 50 })}
        </div>
      )}
      {item.kind === 'type' && (
        <label className="studio__field studio__field--wide">
          <span>{tx('text', lang)}</span>
          <input value={op?.text ?? ''} maxLength={200} onChange={(e) => set({ text: e.target.value })} />
          <small>{tx('textHint', lang)}</small>
        </label>
      )}
      {item.kind === 'key' && (
        <div className="studio__fields">
          <label className="studio__field">
            <span>{tx('key', lang)}</span>
            <input value={op?.key ?? ''} maxLength={16} onChange={(e) => set({ key: e.target.value.trim().toLowerCase() })} />
          </label>
          {num(tx('times', lang), op?.n ?? 1, (v) => set({ n: Math.max(1, Math.min(20, Math.round(Number(v) || 1))) }), { max: 20, step: 1 })}
        </div>
      )}
      {op?.v && <p className="studio__muted">{tx('version', lang, { v: op.v })}</p>}
      <div className="studio__actions">
        {dirty && (
          <>
            <button type="button" className="studio__btn studio__btn--primary" disabled={busy || !valid} onClick={() => op && void saveOp(item, op)}>{tx('saveEdits', lang)}</button>
            <button type="button" className="studio__btn" onClick={() => setDrafts((d) => omit(d, item.key))}>{tx('discard', lang)}</button>
          </>
        )}
        {needsPoint(item.kind) && (
          <button type="button" className={`studio__btn${repick === item.key ? ' is-on' : ''}`} onClick={() => setRepick(repick === item.key ? null : item.key)}>
            🎯 {tx('repick', lang)}
          </button>
        )}
        {item.op && item.trust !== 'verified' && item.trust !== 'disabled' && (
          <button type="button" className="studio__btn" disabled={busy} onClick={() => setFlag(item, { verified: true })}>✔ {tx('confirm', lang)}</button>
        )}
        {item.trust === 'verified' && !item.manual && (
          <button type="button" className="studio__btn" disabled={busy} onClick={() => setFlag(item, { verified: false })}>{tx('unconfirm', lang)}</button>
        )}
        {item.trust === 'disabled' ? (
          <button type="button" className="studio__btn" disabled={busy} onClick={() => setFlag(item, { disabled: false })}>{tx('enable', lang)}</button>
        ) : (
          <button type="button" className="studio__btn" disabled={busy} onClick={() => setFlag(item, { disabled: true })}>⏸ {tx('disable', lang)}</button>
        )}
        {item.edit?.op && item.recorded && (
          <button type="button" className="studio__btn" disabled={busy} onClick={() => resetOp(item)}>↺ {tx('reset', lang)}</button>
        )}
        {item.manual && (
          <button type="button" className="studio__btn studio__btn--danger" disabled={busy} onClick={() => removeOp(item)}>{tx('remove', lang)}</button>
        )}
      </div>
    </div>
  );
}

/** Appium 程式碼(依目前腳本即時產生)。 */
function CodeView({ lang, appId, appName, pageId, pages, edges, opEdits, path }: {
  lang: RLang;
  appId: string;
  appName?: string;
  pageId: string;
  pages: Record<string, ScriptPage>;
  edges: ScriptEdge[];
  opEdits: Record<string, OpEdit>;
  path: ScriptStep[] | null;
}) {
  const [copied, setCopied] = useState(false);
  const p = pages[pageId];
  const spin = spinOpOf(p, opEdits);
  const target = useMemo(
    () => ({ id: pageId, name: p?.name ?? pageId, hashes: [...new Set([p?.pHash, ...(p?.pHashes ?? [])].filter((h): h is string => Boolean(h)))] }),
    [pageId, p],
  );
  const code = useMemo(
    () => (path ? generateAppiumScript({ appId, ...(appName ? { appName } : {}), steps: path, target, handlers: popupHandlers(pages, edges, opEdits), spin }) : ''),
    [path, appId, appName, target, pages, edges, opEdits, spin],
  );
  if (!path) return <p className="studio__empty">{tx('codeNone', lang)}</p>;
  const file = exportFileName(appId, target.name);
  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const lines = code.split('\n');
  return (
    <div className="studio__code">
      <p className="studio__muted">{tx('codeIntro', lang)}</p>
      <pre className="studio__cmd">npm i webdriverio@9 sharp@0.33{'\n'}node {file} --udid &lt;device&gt;{spin ? ' --spins 100' : ''}</pre>
      {spin && <p className="studio__muted">{tx('spinsNote', lang)}</p>}
      <div className="studio__code-bar">
        <span className="studio__code-file">{file}</span>
        <button type="button" className="studio__btn" onClick={() => void navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}>
          {copied ? tx('copied', lang) : tx('copy', lang)}
        </button>
        <button type="button" className="studio__btn studio__btn--primary" onClick={download}>{tx('download', lang)}</button>
      </div>
      <pre className="studio__code-view" tabIndex={0} aria-label={file}>
        {lines.map((l, i) => (
          <span key={i} className="studio__code-line"><span className="studio__code-ln" aria-hidden="true">{i + 1}</span>{l}{'\n'}</span>
        ))}
      </pre>
    </div>
  );
}
