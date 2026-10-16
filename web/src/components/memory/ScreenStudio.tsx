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
  close: ['關閉', 'Close'],
  backToMap: ['↑ 回到關係圖', '↑ Back to map'],
  root: ['起點', 'Start'],
  loading: ['載入畫面', 'Loading screen'],
  visits: ['到過 {n} 次', 'Visited {n}×'],
  summary: ['{ops} 個操作 · {ready} 個會直接執行 · 腳本 {steps} 步', '{ops} actions · {ready} replayed directly · script {steps} steps'],
  summaryNoPath: ['{ops} 個操作 · {ready} 個會直接執行 · 還沒有完整腳本', '{ops} actions · {ready} replayed directly · no full script yet'],
  tabScript: ['腳本與操作', 'Script & actions'],
  tabInfo: ['畫面說明', 'Screen details'],
  tabCode: ['Appium 程式碼', 'Appium code'],
  howTitle: ['這裡的修改會用在哪裡', 'Where these edits are used'],
  how: [
    '「會直接執行」的操作,雲端測試認得畫面就照做(不問 AI,快很多);匯出的 Appium 腳本也照這些步驟。成功 2 次以上且沒失敗會自動啟用,你按「確認」或修正位置會立刻啟用。',
    'Actions marked "replayed" are done directly in cloud runs when the screen is recognised (no AI call, much faster), and the exported Appium script follows the same steps. They turn on after 2+ successes with no failures, or immediately when you confirm or fix them.',
  ],
  pathTitle: ['腳本 · 從起點走到這裡', 'Script · from the start to here'],
  pathRoot: ['這裡就是起點(遊戲開啟後的第一個畫面)。', 'This is the start (first screen after the game opens).'],
  pathNone: [
    '還沒有「從起點走到這裡、而且記得點哪裡」的路徑。讓 AI 跑一次測試走到這個畫面,或在前一個畫面按「新增操作」並指到這裡。',
    'No recorded path with positions from the start to here yet. Run a test that reaches this screen, or use "Add action" on the previous screen and point it here.',
  ],
  stepAt: ['在「{p}」', 'On "{p}"'],
  arrive: ['到達「{p}」', 'Arrive at "{p}"'],
  hereTitle: ['在這個畫面上的操作', 'Actions on this screen'],
  hereEmpty: ['這個畫面還沒有記錄到操作。可以按「新增操作」自己加。', 'No actions recorded on this screen yet. Use "Add action" to create one.'],
  add: ['+ 新增操作', '+ Add action'],
  addTitle: ['新增操作', 'Add an action'],
  addKind: ['動作', 'Action'],
  addName: ['名稱(按鈕上的字)', 'Name (text on the button)'],
  addNamePh: ['例:SPIN、PLAY、關閉 X', 'e.g. SPIN, PLAY, Close X'],
  addResult: ['做完之後', 'Afterwards'],
  addSelf: ['留在這個畫面(例如 SPIN、下注)', 'Stays on this screen (e.g. SPIN, bet)'],
  addTo: ['會到「{p}」', 'Goes to "{p}"'],
  addPick: ['在左邊的截圖上點一下位置', 'Click the spot on the screenshot'],
  addPicked: ['位置 {x}%、{y}%(可在截圖上拖曳調整)', 'At {x}%, {y}% (drag on the screenshot to adjust)'],
  addSave: ['新增', 'Add'],
  addNeedName: ['請填名稱', 'Enter a name'],
  addNeedPoint: ['請在截圖上點位置', 'Pick a spot on the screenshot'],
  addNeedText: ['請填要輸入的文字', 'Enter the text to type'],
  cancel: ['取消', 'Cancel'],
  sameScreen: ['同一畫面', 'Same screen'],
  verified: ['✔ 已確認 · 會直接執行', '✔ Confirmed · replayed'],
  auto: ['⚡ 會直接執行(成功 {n} 次)', '⚡ Replayed ({n} successes)'],
  learning: ['學習中 {n}/{min}', 'Learning {n}/{min}'],
  learningMiss: ['學習中 · 有失敗紀錄,需要確認', 'Learning · has failures, needs confirming'],
  disabled: ['已停用', 'Disabled'],
  noOp: ['沒有位置紀錄(舊資料),請重新指定', 'No position recorded (older data); set one'],
  record: ['成功 {h} · 失敗 {m}', '{h} ok · {m} failed'],
  manual: ['手動新增', 'Added by you'],
  edited: ['已修正', 'Edited'],
  version: ['錄製版本 {v}', 'Recorded on {v}'],
  confirm: ['確認', 'Confirm'],
  unconfirm: ['取消確認', 'Unconfirm'],
  disable: ['停用', 'Disable'],
  enable: ['啟用', 'Enable'],
  repick: ['重新指定位置', 'Set position again'],
  repickBar: ['點截圖上的正確位置…(Esc 取消)', 'Click the right spot on the screenshot… (Esc to cancel)'],
  reset: ['還原 AI 記錄', 'Restore AI recording'],
  remove: ['刪除', 'Delete'],
  removeConfirm: ['刪除這個操作?', 'Delete this action?'],
  saveEdits: ['儲存修改', 'Save changes'],
  discard: ['放棄', 'Discard'],
  startX: ['起點 X %', 'Start X %'],
  startY: ['起點 Y %', 'Start Y %'],
  endX: ['終點 X %', 'End X %'],
  endY: ['終點 Y %', 'End Y %'],
  posX: ['X %', 'X %'],
  posY: ['Y %', 'Y %'],
  holdMs: ['按住(毫秒)', 'Hold (ms)'],
  swipeMs: ['滑動時間(毫秒)', 'Duration (ms)'],
  text: ['要輸入的文字', 'Text to type'],
  textHint: ['帳密請寫 ${password} 這種形式,會讀 App 憑證,不要寫真的密碼', 'Use ${password} style placeholders for credentials; never type the real password'],
  key: ['按鍵(enter、tab、space…)', 'Key (enter, tab, space…)'],
  times: ['次數', 'Times'],
  saved: ['已儲存', 'Saved'],
  failed: ['操作失敗:', 'Failed: '],
  codeNone: ['還沒有從起點到這裡的腳本,先在「腳本與操作」補齊路徑。', 'No script from the start to here yet; complete the path under "Script & actions".'],
  codeIntro: [
    '依目前的腳本即時產生;在「腳本與操作」改步驟,這裡會跟著更新。在你的電腦用 Appium 執行:',
    'Generated live from the current script; edit steps under "Script & actions" and this updates. Run it with Appium on your machine:',
  ],
  copy: ['複製', 'Copy'],
  copied: ['已複製', 'Copied'],
  download: ['下載 .mjs', 'Download .mjs'],
  spinsNote: ['這個畫面有 SPIN,可加 --spins 100 連轉 100 局(本機只點,不讀數字;RTP 請在平台上跑)。', 'This screen has a SPIN; add --spins 100 to spin 100 rounds (taps only locally; run RTP on the platform).'],
  act: { tap: ['點擊', 'Tap'], hold: ['長按', 'Hold'], swipe: ['滑動', 'Swipe'], back: ['返回鍵', 'Back'], type: ['輸入文字', 'Type'], key: ['按鍵', 'Key'], move: ['搖桿', 'Joystick'] },
} as const;
type Key = Exclude<keyof typeof T, 'act'>;
const tx = (k: Key, lang: RLang, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce<string>((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), T[k][lang === 'zh' ? 0 : 1]);
const actName = (a: string, lang: RLang) => (T.act as Record<string, readonly [string, string]>)[a]?.[lang === 'zh' ? 0 : 1] ?? a;
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
