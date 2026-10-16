import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiDelete, apiGet, apiPost, apiPut } from '../../api/client.ts';
import type { RLang } from '../report/reportText.ts';
import type { MemOp } from './memoryScript.ts';
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
  hintsTitle: ['AI 記憶 · 使用者教學', 'AI memory · what you taught it'],
  hintsDesc: ['每次測試開始時,AI 都會讀到這些經驗;綁定畫面的提示會在 AI 回到該畫面時再提醒一次。測試中在聊天室下的指令(勾「記住」)會自動出現在這裡。', 'The AI reads these at the start of every run; screen-scoped hints are repeated when the AI returns to that screen. Instructions sent from the live chat (with “remember” checked) show up here.'],
  hintsEmpty: ['還沒有任何教學。可以在測試中用聊天室下指令,或直接在下方新增。', 'Nothing taught yet. Send instructions from the live chat during a run, or add one below.'],
  addPlaceholder: ['例:老虎機畫面要點右下角的 SPIN 按鈕才會開始轉', 'e.g. On the slot screen, tap SPIN at the bottom right to start'],
  add: ['新增', 'Add'],
  adding: ['新增中…', 'Adding…'],
  scopeAll: ['整個應用通用', 'Whole app'],
  scopeLabel: ['適用畫面', 'Applies to'],
  srcOperator: ['即時指令', 'Live chat'],
  srcManual: ['手動新增', 'Manual'],
  enabled: ['啟用', 'Enabled'],
  disabled: ['已停用', 'Disabled'],
  edit: ['編輯', 'Edit'],
  save: ['儲存', 'Save'],
  cancel: ['取消', 'Cancel'],
  del: ['刪除', 'Delete'],
  delConfirm: ['確定刪除這條記憶?', 'Delete this hint?'],
  failed: ['操作失敗:', 'Failed: '],
  fromJob: ['來自測試', 'From run'],
  step: ['第 {n} 步', 'step {n}'],
  gridHint: ['點畫面卡片可改名、加這個畫面的提示、刪除錯誤的路徑或畫面。', 'Click a screen to rename it, add hints for it, or delete wrong paths or screens.'],
  // drawer
  close: ['關閉', 'Close'],
  rename: ['畫面名稱', 'Screen name'],
  renameSave: ['改名', 'Rename'],
  aiName: ['AI 原始命名', 'AI name'],
  resetName: ['還原 AI 命名', 'Restore AI name'],
  pageNotes: ['這個畫面的提示', 'Hints for this screen'],
  pageNotesEmpty: ['還沒有針對這個畫面的提示。', 'No hints for this screen yet.'],
  notePlaceholder: ['例:這裡要點右下方的 SPIN', 'e.g. Tap SPIN at the bottom right here'],
  outgoing: ['從這裡出去的路徑', 'Paths out of this screen'],
  incoming: ['進到這裡的路徑', 'Paths into this screen'],
  noEdges: ['沒有記錄的路徑。', 'No recorded paths.'],
  delEdge: ['刪除路徑', 'Delete path'],
  delEdgeConfirm: ['刪除這條路徑?AI 之後不會再把它當成已驗證的走法。', 'Delete this path? The AI will no longer treat it as a verified route.'],
  delPage: ['刪除這個畫面', 'Delete this screen'],
  delPageConfirm: ['刪除這個畫面與相關路徑?可在「已刪除」清單還原。', 'Delete this screen and its paths? You can restore it from the “Deleted” list.'],
  visits: ['次造訪', 'visits'],
  hit: ['成功', 'ok'],
  miss: ['失敗', 'miss'],
  aliases: ['別名', 'Aliases'],
  // deleted
  deletedTitle: ['已刪除', 'Deleted'],
  deletedPages: ['畫面', 'Screens'],
  deletedEdges: ['路徑', 'Paths'],
  restore: ['還原', 'Restore'],
  // 關係圖編輯
  manualEdge: ['✋ 人工', '✋ Manual'],
  loadingTag: ['載入', 'Loading'],
  graphEditHint: [
    '可直接在圖上編輯:拖曳畫面調整位置(自動儲存)· 點畫面開啟編修 · 從畫面右側圓點拉到另一個畫面新增路徑 · 選取畫面或路徑後按 Delete 刪除 · 把畫面拖到另一個畫面上可合併。',
    'Edit right on the graph: drag screens to arrange them (auto-saved) · click a screen to edit it · drag from the right dot to another screen to add a path · select a screen or path and press Delete · drop a screen onto another to merge them.',
  ],
  relayout: ['重新排版', 'Auto layout'],
  relayoutConfirm: ['清除手動排列的位置,改回自動排版?', 'Clear manual positions and go back to auto layout?'],
  saving: ['儲存中…', 'Saving…'],
  addEdgeTitle: ['新增路徑', 'Add path'],
  addEdgeKind: ['怎麼過去', 'How'],
  kindTap: ['點擊 (tap)', 'Tap'],
  kindSwipe: ['滑動 (swipe)', 'Swipe'],
  kindBack: ['返回 (back)', 'Back'],
  kindAuto: ['自動轉場 (auto)', 'Automatic (auto)'],
  addEdgeTarget: ['要點 / 操作的元件', 'Element to tap / use'],
  addEdgeTargetPh: ['例:開始遊戲、右下角 SPIN', 'e.g. Start, SPIN at the bottom right'],
  addEdgeHint: ['手動路徑會標成「人工」,AI 會把它當成可靠的正確走法優先參考。', 'Manual paths are marked “Manual”; the AI treats them as reliable routes and follows them first.'],
  delSelConfirm: ['刪除選取的 {n} 個項目?畫面可在「已刪除」清單還原。', 'Delete {n} selected item(s)? Screens can be restored from the “Deleted” list.'],
  mergeConfirm: ['把「{from}」合併到「{to}」?\n造訪次數、別名、截圖特徵與路徑都會併入「{to}」。這個動作無法復原。', 'Merge “{from}” into “{to}”?\nVisits, aliases, image fingerprints and paths move to “{to}”. This cannot be undone.'],
  mergeDrop: ['放開即合併到這個畫面', 'Drop to merge into this screen'],
} as const;
export type MemTextKey = keyof typeof T;
export const mt = (k: MemTextKey, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];

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
