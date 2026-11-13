import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiDelete, apiGet, apiPost, apiPut } from '../../api/client.ts';
import type { RLang } from '../report/reportText.ts';
import type { MemOp } from './memoryScript.ts';
import { pick5 } from '../../i18n/locale5.ts';
import './MemoryEditor.css';

/**
 * 記憶地圖的手動編修:
 * - HintsPanel:應用記憶(使用者教 AI 的經驗;來自測試中的即時指令或手動新增)。
 * - PageInfo:單一畫面的改名 / 畫面專屬提示 / 路徑刪除 / 刪除畫面(畫面工作區的「畫面說明」分頁)。
 * - DeletedPanel:已刪除的畫面與路徑,可還原。
 * 後端:infra/lambda/api/memoryHints.ts(hints.json / edits.json 覆寫層,不會被下次執行洗掉)。
 */

export interface MemoryHint {
  id: string;
  text: string;
  pageId?: string;
  screen?: string;
  source: 'operator' | 'manual';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  jobId?: string;
  step?: number;
}

export interface EditPage {
  id: string;
  name: string;
  visitCount: number;
  aliases?: Record<string, number>;
  renamed?: boolean;
  autoName?: string;
  screenshotUrl?: string;
}
export interface EditEdge {
  fromPageId: string;
  toPageId: string;
  trigger?: { kind?: string; label?: string; target?: string };
  hitCount: number;
  missCount: number;
  /** 使用者在記憶關係圖手動標註的路徑。 */
  manual?: boolean;
  /** 最近一次造成這個轉場的操作(記憶腳本)。 */
  op?: MemOp;
}

/** 刪除路徑的編修指令:純手動(AI 沒走過)的只移除標註,不進「已刪除」清單。 */
export function deleteEdgeOp(e: EditEdge): { op: 'deleteEdge'; edgeKey: string; manualOnly?: boolean } {
  const manualOnly = Boolean(e.manual) && e.hitCount === 0 && e.missCount === 0;
  return { op: 'deleteEdge', edgeKey: edgeKey(e), ...(manualOnly ? { manualOnly: true } : {}) };
}
export interface DeletedInfo {
  pages: Array<{ id: string; name: string }>;
  edges: Array<{ key: string; from: string; to: string; label?: string }>;
}

/** 路徑識別鍵(與後端 / runner 的 edgeKey 一致:from>to>kind>target)。 */
export function edgeKey(e: EditEdge): string {
  return `${e.fromPageId}>${e.toPageId}>${e.trigger?.kind ?? ''}>${(e.trigger?.target ?? '').trim()}`;
}

const T = {
  hintsTitle: ['AI 記憶 · 使用者教學', 'AI memory · what you taught it', 'AI 记忆 · 用户教学', 'AI メモリ · ユーザーの教え', 'AI 메모리 · 사용자 가르침'],
  hintsDesc: ['每次測試開始時,AI 都會讀到這些經驗;綁定畫面的提示會在 AI 回到該畫面時再提醒一次。測試中在聊天室下的指令(勾「記住」)會自動出現在這裡。', 'The AI reads these at the start of every run; screen-scoped hints are repeated when the AI returns to that screen. Instructions sent from the live chat (with “remember” checked) show up here.', '每次测试开始时,AI 都会读到这些经验;绑定画面的提示会在 AI 回到该画面时再提醒一次。测试中在聊天室下的指令(勾「记住」)会自动出现在这里。', 'テスト開始時に毎回 AI がこれらの経験を読み込みます。画面に紐づけたヒントは、AI がその画面に戻ったときにもう一度通知されます。テスト中にチャットで出した指示(「記憶する」にチェック)は自動でここに表示されます。', '테스트를 시작할 때마다 AI가 이 경험들을 읽습니다. 화면에 연결한 힌트는 AI가 그 화면으로 돌아올 때 다시 알려 줍니다. 테스트 중 채팅으로 내린 지시(\'기억\' 체크)는 자동으로 여기에 표시됩니다.'],
  hintsEmpty: ['還沒有任何教學。可以在測試中用聊天室下指令,或直接在下方新增。', 'Nothing taught yet. Send instructions from the live chat during a run, or add one below.', '还没有任何教学。可以在测试中用聊天室下指令,或直接在下方添加。', 'まだ教えはありません。テスト中にチャットで指示を出すか、下で直接追加できます。', '아직 가르침이 없습니다. 테스트 중 채팅으로 지시하거나 아래에서 직접 추가할 수 있습니다.'],
  addPlaceholder: ['例:老虎機畫面要點右下角的 SPIN 按鈕才會開始轉', 'e.g. On the slot screen, tap SPIN at the bottom right to start', '例:老虎机画面要点右下角的 SPIN 按钮才会开始转', '例:スロット画面では右下の SPIN ボタンをタップすると回り始める', '예: 슬롯 화면에서는 오른쪽 아래 SPIN 버튼을 눌러야 돌기 시작합니다'],
  add: ['新增', 'Add', '添加', '追加', '추가'],
  adding: ['新增中…', 'Adding…', '添加中…', '追加中…', '추가하는 중…'],
  scopeAll: ['整個應用通用', 'Whole app', '整个应用通用', 'アプリ全体で共通', '앱 전체 공통'],
  scopeLabel: ['適用畫面', 'Applies to', '适用画面', '対象の画面', '적용 화면'],
  srcOperator: ['即時指令', 'Live chat', '即时指令', 'ライブ指示', '실시간 지시'],
  srcManual: ['手動新增', 'Manual', '手动添加', '手動追加', '직접 추가'],
  enabled: ['啟用', 'Enabled', '激活', '有効', '사용'],
  disabled: ['已停用', 'Disabled', '已停用', '無効', '사용 안 함'],
  edit: ['編輯', 'Edit', '编辑', '編集', '편집'],
  save: ['儲存', 'Save', '保存', '保存', '저장'],
  cancel: ['取消', 'Cancel', '取消', 'キャンセル', '취소'],
  del: ['刪除', 'Delete', '删除', '削除', '삭제'],
  delConfirm: ['確定刪除這條記憶?', 'Delete this hint?', '确定删除这条记忆?', 'このメモリを削除しますか?', '이 기억을 삭제하시겠습니까?'],
  failed: ['操作失敗:', 'Failed: ', '操作失败:', '操作に失敗しました:', '작업 실패:'],
  fromJob: ['來自測試', 'From run', '来自测试', 'テストから', '테스트에서'],
  step: ['第 {n} 步', 'step {n}', '第 {n} 步', 'ステップ {n}', '{n}단계'],
  gridHint: ['點畫面卡片可改名、加這個畫面的提示、刪除錯誤的路徑或畫面。', 'Click a screen to rename it, add hints for it, or delete wrong paths or screens.', '点画面卡片可改名、加这个画面的提示、删调试误的路径或画面。', '画面カードをクリックすると、名前の変更、その画面へのヒント追加、誤った経路や画面の削除ができます。', '화면 카드를 클릭하면 이름 변경, 해당 화면의 힌트 추가, 잘못된 경로나 화면 삭제를 할 수 있습니다.'],
  // drawer
  close: ['關閉', 'Close', '关闭', '閉じる', '닫기'],
  rename: ['畫面名稱', 'Screen name', '画面名称', '画面名', '화면 이름'],
  renameSave: ['改名', 'Rename', '改名', '名前を変更', '이름 변경'],
  aiName: ['AI 原始命名', 'AI name', 'AI 原始命名', 'AI による元の名前', 'AI 원래 이름'],
  resetName: ['還原 AI 命名', 'Restore AI name', '还原 AI 命名', 'AI の名前に戻す', 'AI 이름으로 되돌리기'],
  pageNotes: ['這個畫面的提示', 'Hints for this screen', '这个画面的提示', 'この画面のヒント', '이 화면의 힌트'],
  pageNotesEmpty: ['還沒有針對這個畫面的提示。', 'No hints for this screen yet.', '还没有针对这个画面的提示。', 'この画面に対するヒントはまだありません。', '이 화면에 대한 힌트가 아직 없습니다.'],
  notePlaceholder: ['例:這裡要點右下方的 SPIN', 'e.g. Tap SPIN at the bottom right here', '例:这里要点右下方的 SPIN', '例:ここでは右下の SPIN をタップする', '예: 여기서는 오른쪽 아래 SPIN을 누릅니다'],
  outgoing: ['從這裡出去的路徑', 'Paths out of this screen', '从这里出去的路径', 'この画面からの経路', '이 화면에서 나가는 경로'],
  incoming: ['進到這裡的路徑', 'Paths into this screen', '进到这里的路径', 'この画面への経路', '이 화면으로 들어오는 경로'],
  noEdges: ['沒有記錄的路徑。', 'No recorded paths.', '没有记录的路径。', '記録された経路はありません。', '기록된 경로가 없습니다.'],
  delEdge: ['刪除路徑', 'Delete path', '删除路径', '経路を削除', '경로 삭제'],
  delEdgeConfirm: ['刪除這條路徑?AI 之後不會再把它當成已驗證的走法。', 'Delete this path? The AI will no longer treat it as a verified route.', '删除这条路径?AI 之后不会再把它当成已验证的走法。', 'この経路を削除しますか?AI は今後これを検証済みの経路として扱いません。', '이 경로를 삭제하시겠습니까? AI는 이후 이것을 검증된 경로로 취급하지 않습니다.'],
  delPage: ['刪除這個畫面', 'Delete this screen', '删除这个画面', 'この画面を削除', '이 화면 삭제'],
  delPageConfirm: ['刪除這個畫面與相關路徑?可在「已刪除」清單還原。', 'Delete this screen and its paths? You can restore it from the “Deleted” list.', '删除这个画面与相关路径?可在「已删除」清单还原。', 'この画面と関連する経路を削除しますか?「削除済み」リストから復元できます。', '이 화면과 관련 경로를 삭제하시겠습니까? \'삭제됨\' 목록에서 복원할 수 있습니다.'],
  visits: ['次造訪', 'visits', '次造访', '回訪問', '회 방문'],
  hit: ['成功', 'ok', '成功', '成功', '성공'],
  miss: ['失敗', 'miss', '失败', '失敗', '실패'],
  aliases: ['別名', 'Aliases', '别名', '別名', '별칭'],
  // deleted
  deletedTitle: ['已刪除', 'Deleted', '已删除', '削除済み', '삭제됨'],
  deletedPages: ['畫面', 'Screens', '画面', '画面', '화면'],
  deletedEdges: ['路徑', 'Paths', '路径', '経路', '경로'],
  restore: ['還原', 'Restore', '还原', '復元', '복원'],
  // 關係圖編輯
  manualEdge: ['✋ 人工', '✋ Manual', '✋ 人工', '✋ 手動', '✋ 수동'],
  loadingTag: ['載入', 'Loading', '加载', '読み込み中', '불러오는 중'],
  graphEditHint: [
    '可直接在圖上編輯:拖曳畫面調整位置(自動儲存)· 點畫面開啟編修 · 從畫面右側圓點拉到另一個畫面新增路徑 · 選取畫面或路徑後按 Delete 刪除 · 把畫面拖到另一個畫面上可合併。',
    'Edit right on the graph: drag screens to arrange them (auto-saved) · click a screen to edit it · drag from the right dot to another screen to add a path · select a screen or path and press Delete · drop a screen onto another to merge them.', '可直接在图上编辑:拖曳画面调整位置(自动保存)· 点画面打开编修 · 从画面右侧圆点拉到另一个画面添加路径 · 选取画面或路径后按 Delete 删除 · 把画面拖到另一个画面上可合并。', 'グラフ上で直接編集できます:画面をドラッグして配置を調整(自動保存)· 画面をクリックして編集 · 画面右側の点から別の画面へドラッグして経路を追加 · 画面または経路を選択して Delete で削除 · 画面を別の画面にドラッグして統合。', '그래프에서 바로 편집할 수 있습니다: 화면을 드래그해 위치 조정(자동 저장) · 화면을 클릭해 편집 · 화면 오른쪽 점에서 다른 화면으로 끌어 경로 추가 · 화면이나 경로를 선택하고 Delete로 삭제 · 화면을 다른 화면 위로 끌어 병합.',
  ],
  relayout: ['重新排版', 'Auto layout', '重新排版', '再レイアウト', '다시 배치'],
  relayoutConfirm: ['清除手動排列的位置,改回自動排版?', 'Clear manual positions and go back to auto layout?', '清除手动排列的位置,改回自动排版?', '手動で配置した位置をクリアして自動レイアウトに戻しますか?', '수동으로 배치한 위치를 지우고 자동 배치로 되돌리시겠습니까?'],
  saving: ['儲存中…', 'Saving…', '保存中…', '保存中…', '저장하는 중…'],
  addEdgeTitle: ['新增路徑', 'Add path', '添加路径', '経路を追加', '경로 추가'],
  addEdgeKind: ['怎麼過去', 'How', '怎么过去', '移動方法', '이동 방법'],
  kindTap: ['點擊 (tap)', 'Tap', '点击 (tap)', 'タップ (tap)', '탭 (tap)'],
  kindSwipe: ['滑動 (swipe)', 'Swipe', '滑动 (swipe)', 'スワイプ (swipe)', '스와이프 (swipe)'],
  kindBack: ['返回 (back)', 'Back', '返回 (back)', '戻る (back)', '뒤로 (back)'],
  kindAuto: ['自動轉場 (auto)', 'Automatic (auto)', '自动转场 (auto)', '自動遷移 (auto)', '자동 전환 (auto)'],
  addEdgeTarget: ['要點 / 操作的元件', 'Element to tap / use', '要点 / 操作的组件', 'タップ / 操作する要素', '누르거나 조작할 요소'],
  addEdgeTargetPh: ['例:開始遊戲、右下角 SPIN', 'e.g. Start, SPIN at the bottom right', '例:开始游戏、右下角 SPIN', '例:ゲーム開始、右下の SPIN', '예: 게임 시작, 오른쪽 아래 SPIN'],
  addEdgeHint: ['手動路徑會標成「人工」,AI 會把它當成可靠的正確走法優先參考。', 'Manual paths are marked “Manual”; the AI treats them as reliable routes and follows them first.', '手动路径会标成「人工」,AI 会把它当成可靠的正确走法优先参考。', '手動の経路は「手動」と表示され、AI は信頼できる正しいルートとして優先的に参照します。', '수동 경로는 \'수동\'으로 표시되며, AI는 이를 신뢰할 수 있는 올바른 경로로 보고 우선 참고합니다.'],
  delSelConfirm: ['刪除選取的 {n} 個項目?畫面可在「已刪除」清單還原。', 'Delete {n} selected item(s)? Screens can be restored from the “Deleted” list.', '删除选取的 {n} 个项目?画面可在「已删除」清单还原。', '選択した {n} 件を削除しますか?画面は「削除済み」リストから復元できます。', '선택한 {n}개 항목을 삭제하시겠습니까? 화면은 \'삭제됨\' 목록에서 복원할 수 있습니다.'],
  mergeConfirm: ['把「{from}」合併到「{to}」?\n造訪次數、別名、截圖特徵與路徑都會併入「{to}」。這個動作無法復原。', 'Merge “{from}” into “{to}”?\nVisits, aliases, image fingerprints and paths move to “{to}”. This cannot be undone.', '把「{from}」合并到「{to}」?\n造访次数、别名、截图特征与路径都会并入「{to}」。这个动作无法复原。', '「{from}」を「{to}」に統合しますか?\n訪問回数、別名、スクリーンショット特徴、経路はすべて「{to}」に統合されます。この操作は元に戻せません。', '\'{from}\'을(를) \'{to}\'(으)로 병합하시겠습니까?\n방문 횟수, 별칭, 스크린샷 특징, 경로가 모두 \'{to}\'(으)로 합쳐집니다. 이 작업은 되돌릴 수 없습니다.'],
  mergeDrop: ['放開即合併到這個畫面', 'Drop to merge into this screen', '放开即合并到这个画面', '離すとこの画面に統合', '놓으면 이 화면으로 병합'],
} as const;
export type MemTextKey = keyof typeof T;
export const mt = (k: MemTextKey, lang: RLang) => pick5(T[k], lang);

/** 載入 / 編修某應用的記憶提示。 */
export function useMemoryHints(appId: string) {
  const [hints, setHints] = useState<MemoryHint[]>([]);
  const reload = useCallback(async () => {
    if (!appId) { setHints([]); return; }
    try {
      const r = await apiGet<{ items: MemoryHint[] }>(`/memory/hints?app=${encodeURIComponent(appId)}`);
      setHints(r.items ?? []);
    } catch { setHints([]); }
  }, [appId]);
  useEffect(() => { void reload(); }, [reload]);

  const add = useCallback(async (text: string, pageId?: string) => {
    const h = await apiPost<MemoryHint>('/memory/hints', { app: appId, text, ...(pageId ? { pageId } : {}) });
    setHints((prev) => (prev.some((x) => x.id === h.id) ? prev.map((x) => (x.id === h.id ? h : x)) : [...prev, h]));
  }, [appId]);
  const update = useCallback(async (id: string, patch: { text?: string; enabled?: boolean; pageId?: string | null }) => {
    const body: Record<string, unknown> = { app: appId };
    if (patch.text !== undefined) body['text'] = patch.text;
    if (patch.enabled !== undefined) body['enabled'] = patch.enabled;
    if (patch.pageId !== undefined) body['pageId'] = patch.pageId ?? '';
    const h = await apiPut<MemoryHint>(`/memory/hints/${encodeURIComponent(id)}`, body);
    setHints((prev) => prev.map((x) => (x.id === id ? h : x)));
  }, [appId]);
  const remove = useCallback(async (id: string) => {
    await apiDelete(`/memory/hints/${encodeURIComponent(id)}?app=${encodeURIComponent(appId)}`);
    setHints((prev) => prev.filter((x) => x.id !== id));
  }, [appId]);

  return { hints, reload, add, update, remove };
}
export type HintsApi = ReturnType<typeof useMemoryHints>;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 一條提示(可啟用/停用、編輯、刪除)。 */
function HintRow({ hint, lang, scope, api, onError }: {
  hint: MemoryHint; lang: RLang; scope: string; api: HintsApi; onError: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(hint.text);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (err) { onError(`${mt('failed', lang)}${errText(err)}`); } finally { setBusy(false); }
  }

  return (
    <li className={`memedit__hint ${hint.enabled ? '' : 'is-off'}`}>
      {editing ? (
        <form
          className="memedit__hint-edit"
          onSubmit={(e) => {
            e.preventDefault();
            const t = draft.trim();
            if (!t) return;
            void run(async () => { await api.update(hint.id, { text: t }); setEditing(false); });
          }}
        >
          <label className="visually-hidden" htmlFor={`hint-${hint.id}`}>{mt('edit', lang)}</label>
          <textarea id={`hint-${hint.id}`} rows={2} maxLength={500} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="memedit__actions">
            <button type="submit" className="memedit__btn memedit__btn--primary" disabled={busy || !draft.trim()}>{mt('save', lang)}</button>
            <button type="button" className="memedit__btn" onClick={() => { setDraft(hint.text); setEditing(false); }}>{mt('cancel', lang)}</button>
          </div>
        </form>
      ) : (
        <p className="memedit__hint-text">{hint.text}</p>
      )}
      <div className="memedit__hint-meta">
        <span className="memedit__chip">{scope}</span>
        <span className={`memedit__chip memedit__chip--${hint.source}`}>{hint.source === 'operator' ? mt('srcOperator', lang) : mt('srcManual', lang)}</span>
        {hint.jobId && (
          <span className="memedit__muted">
            {mt('fromJob', lang)} {hint.jobId}{typeof hint.step === 'number' ? ` · ${mt('step', lang).replace('{n}', String(hint.step))}` : ''}
          </span>
        )}
        <span className="memedit__muted">{new Date(hint.updatedAt).toLocaleDateString()}</span>
        <span className="memedit__spacer" />
        <label className="memedit__toggle">
          <input
            type="checkbox"
            checked={hint.enabled}
            disabled={busy}
            onChange={(e) => { const v = e.target.checked; void run(() => api.update(hint.id, { enabled: v })); }}
          />
          {hint.enabled ? mt('enabled', lang) : mt('disabled', lang)}
        </label>
        {!editing && (
          <button type="button" className="memedit__link" disabled={busy} onClick={() => { setDraft(hint.text); setEditing(true); }}>{mt('edit', lang)}</button>
        )}
        <button
          type="button"
          className="memedit__link memedit__link--danger"
          disabled={busy}
          onClick={() => { if (window.confirm(mt('delConfirm', lang))) void run(() => api.remove(hint.id)); }}
        >
          {mt('del', lang)}
        </button>
      </div>
    </li>
  );
}

/** 「新增提示」表單。pageOptions 有值時可選擇綁定畫面。 */
function AddHintForm({ lang, api, pageOptions, fixedPageId, placeholder, onError }: {
  lang: RLang; api: HintsApi; pageOptions?: Array<{ id: string; name: string }>; fixedPageId?: string; placeholder: string; onError: (m: string) => void;
}) {
  const [text, setText] = useState('');
  const [pageId, setPageId] = useState('');
  const [busy, setBusy] = useState(false);
  const idBase = fixedPageId ?? 'all';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.add(t, fixedPageId ?? (pageId || undefined));
      setText('');
    } catch (err) {
      onError(`${mt('failed', lang)}${errText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="memedit__add" onSubmit={submit}>
      <label className="visually-hidden" htmlFor={`addhint-${idBase}`}>{placeholder}</label>
      <textarea id={`addhint-${idBase}`} rows={2} maxLength={500} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
      <div className="memedit__actions">
        {pageOptions && !fixedPageId && (
          <label className="memedit__scope">
            <span>{mt('scopeLabel', lang)}</span>
            <select value={pageId} onChange={(e) => setPageId(e.target.value)}>
              <option value="">{mt('scopeAll', lang)}</option>
              {pageOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <button type="submit" className="memedit__btn memedit__btn--primary" disabled={busy || !text.trim()}>
          {busy ? mt('adding', lang) : mt('add', lang)}
        </button>
      </div>
    </form>
  );
}

/** 提示的適用範圍文字。 */
function scopeOf(h: MemoryHint, pageName: (id: string) => string | undefined, lang: RLang): string {
  if (h.pageId) return pageName(h.pageId) ?? h.screen ?? h.pageId;
  if (h.screen) return h.screen;
  return mt('scopeAll', lang);
}

export function HintsPanel({ lang, api, pages }: { lang: RLang; api: HintsApi; pages: Array<{ id: string; name: string }> }) {
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(pages.map((p) => [p.id, p.name]));
  const sorted = [...api.hints].sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.updatedAt.localeCompare(a.updatedAt));
  return (
    <section className="memedit memedit__panel" aria-labelledby="memedit-hints-title">
      <div className="memedit__panel-head">
        <h2 id="memedit-hints-title" className="memedit__title">{mt('hintsTitle', lang)}</h2>
        <span className="memedit__count">{api.hints.filter((h) => h.enabled).length}/{api.hints.length}</span>
      </div>
      <p className="memedit__desc">{mt('hintsDesc', lang)}</p>
      {sorted.length === 0 ? (
        <p className="memedit__empty">{mt('hintsEmpty', lang)}</p>
      ) : (
        <ul className="memedit__hints">
          {sorted.map((h) => (
            <HintRow key={h.id} hint={h} lang={lang} api={api} scope={scopeOf(h, (id) => byId.get(id), lang)} onError={setError} />
          ))}
        </ul>
      )}
      <AddHintForm lang={lang} api={api} pageOptions={pages} placeholder={mt('addPlaceholder', lang)} onError={setError} />
      {error && <p className="memedit__error" role="alert">{error}</p>}
    </section>
  );
}

/**
 * 單一畫面的說明與設定(改名 / 畫面提示 / 進出路徑 / 刪除)。
 * 嵌在記憶地圖的「畫面工作區」說明分頁裡(不是彈出視窗)。
 */
export function PageInfo({ lang, appId, page, edges, pageName, api, onDeleted, onEdited, onOpenPage }: {
  lang: RLang;
  appId: string;
  page: EditPage;
  edges: EditEdge[];
  pageName: (id: string) => string;
  api: HintsApi;
  /** 畫面被刪除後(外層取消選取)。 */
  onDeleted: () => void;
  onEdited: () => void;
  /** 點路徑另一端的畫面 → 切換到那個畫面。 */
  onOpenPage?: (pageId: string) => void;
}) {
  const [name, setName] = useState(page.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setName(page.name); }, [page.id, page.name]);

  async function edit(body: Record<string, unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await apiPost('/memory/edit', { app: appId, ...body });
      onEdited();
      after?.();
    } catch (err) {
      setError(`${mt('failed', lang)}${errText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const names = new Set([page.name, page.autoName, ...Object.keys(page.aliases ?? {})].filter(Boolean) as string[]);
  const notes = api.hints.filter((h) => h.pageId === page.id || (!h.pageId && h.screen && names.has(h.screen)));
  const out = edges.filter((e) => e.fromPageId === page.id);
  const inc = edges.filter((e) => e.toPageId === page.id && e.fromPageId !== page.id);
  const aliasList = Object.keys(page.aliases ?? {}).filter((n) => n !== page.name);

  const edgeRow = (e: EditEdge, otherId: string, arrow: 'in' | 'out') => {
    const k = edgeKey(e);
    const act = [e.trigger?.kind, e.trigger?.label ?? e.trigger?.target].filter(Boolean).join(' · ');
    const other = arrow === 'out' ? `→ ${pageName(otherId)}` : `${pageName(otherId)} →`;
    return (
      <li key={k} className="memedit__edge">
        <div className="memedit__edge-body">
          {onOpenPage ? (
            <button type="button" className="memedit__edge-to memedit__edge-link" onClick={() => onOpenPage(otherId)}>{other}</button>
          ) : (
            <span className="memedit__edge-to">{other}</span>
          )}
          {act && <span className="memedit__muted">{act}</span>}
          {e.manual && <span className="memedit__chip memedit__chip--handedge">{mt('manualEdge', lang)}</span>}
          <span className="memedit__muted">{mt('hit', lang)} {e.hitCount} · {mt('miss', lang)} {e.missCount}</span>
        </div>
        <button
          type="button"
          className="memedit__link memedit__link--danger"
          disabled={busy}
          onClick={() => { if (window.confirm(mt('delEdgeConfirm', lang))) void edit(deleteEdgeOp(e)); }}
        >
          {mt('delEdge', lang)}
        </button>
      </li>
    );
  };

  return (
    <div className="memedit memedit__info">
        <p className="memedit__muted">{page.visitCount} {mt('visits', lang)}{aliasList.length ? ` · ${mt('aliases', lang)}: ${aliasList.slice(0, 8).join('、')}` : ''}</p>

        <form
          className="memedit__rename"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (n && n !== page.name) void edit({ op: 'rename', pageId: page.id, name: n });
          }}
        >
          <label htmlFor="memedit-rename">{mt('rename', lang)}</label>
          <div className="memedit__actions">
            <input id="memedit-rename" type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="memedit__btn memedit__btn--primary" disabled={busy || !name.trim() || name.trim() === page.name}>{mt('renameSave', lang)}</button>
          </div>
          {page.renamed && (
            <p className="memedit__muted">
              {mt('aiName', lang)}:{page.autoName ?? '—'}{' '}
              <button type="button" className="memedit__link" disabled={busy} onClick={() => void edit({ op: 'clearRename', pageId: page.id })}>{mt('resetName', lang)}</button>
            </p>
          )}
        </form>

        <section className="memedit__section">
          <h3 className="memedit__subtitle">{mt('pageNotes', lang)}</h3>
          {notes.length === 0 ? (
            <p className="memedit__empty">{mt('pageNotesEmpty', lang)}</p>
          ) : (
            <ul className="memedit__hints">
              {notes.map((h) => (
                <HintRow key={h.id} hint={h} lang={lang} api={api} scope={page.name} onError={setError} />
              ))}
            </ul>
          )}
          <AddHintForm lang={lang} api={api} fixedPageId={page.id} placeholder={mt('notePlaceholder', lang)} onError={setError} />
        </section>

        <section className="memedit__section">
          <h3 className="memedit__subtitle">{mt('outgoing', lang)}</h3>
          {out.length === 0 ? <p className="memedit__empty">{mt('noEdges', lang)}</p> : <ul className="memedit__edges">{out.map((e) => edgeRow(e, e.toPageId, 'out'))}</ul>}
          <h3 className="memedit__subtitle">{mt('incoming', lang)}</h3>
          {inc.length === 0 ? <p className="memedit__empty">{mt('noEdges', lang)}</p> : <ul className="memedit__edges">{inc.map((e) => edgeRow(e, e.fromPageId, 'in'))}</ul>}
        </section>

        {error && <p className="memedit__error" role="alert">{error}</p>}

        <footer className="memedit__info-foot">
          <button
            type="button"
            className="memedit__btn memedit__btn--danger"
            disabled={busy}
            onClick={() => { if (window.confirm(mt('delPageConfirm', lang))) void edit({ op: 'deletePage', pageId: page.id }, onDeleted); }}
          >
            {mt('delPage', lang)}
          </button>
        </footer>
    </div>
  );
}

/** 已刪除的畫面 / 路徑(可還原)。 */
export function DeletedPanel({ lang, appId, deleted, onEdited }: { lang: RLang; appId: string; deleted: DeletedInfo; onEdited: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (deleted.pages.length === 0 && deleted.edges.length === 0) return null;

  async function restore(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await apiPost('/memory/edit', { app: appId, ...body });
      onEdited();
    } catch (err) {
      setError(`${mt('failed', lang)}${errText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="memedit memedit__panel memedit__deleted">
      <summary className="memedit__title">{mt('deletedTitle', lang)} ({deleted.pages.length + deleted.edges.length})</summary>
      {deleted.pages.length > 0 && (
        <>
          <h3 className="memedit__subtitle">{mt('deletedPages', lang)}</h3>
          <ul className="memedit__edges">
            {deleted.pages.map((p) => (
              <li key={p.id} className="memedit__edge">
                <span className="memedit__edge-to">{p.name}</span>
                <button type="button" className="memedit__link" disabled={busy} onClick={() => void restore({ op: 'restorePage', pageId: p.id })}>{mt('restore', lang)}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {deleted.edges.length > 0 && (
        <>
          <h3 className="memedit__subtitle">{mt('deletedEdges', lang)}</h3>
          <ul className="memedit__edges">
            {deleted.edges.map((e) => (
              <li key={e.key} className="memedit__edge">
                <div className="memedit__edge-body">
                  <span className="memedit__edge-to">{e.from} → {e.to}</span>
                  {e.label && <span className="memedit__muted">{e.label}</span>}
                </div>
                <button type="button" className="memedit__link" disabled={busy} onClick={() => void restore({ op: 'restoreEdge', edgeKey: e.key })}>{mt('restore', lang)}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="memedit__error" role="alert">{error}</p>}
    </details>
  );
}
