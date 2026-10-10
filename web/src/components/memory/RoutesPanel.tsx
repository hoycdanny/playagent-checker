import { useState } from 'react';
import type { RLang } from '../report/reportText.ts';

/**
 * 操作路線:測試人員在關係圖上依序點畫面畫出的流程(整個應用共用,每次測試 AI 都會照著走)。
 * 支線:某一步可能遇到的岔路(例如當天限定活動彈窗)——先處理,再回到指定步驟。
 * 後端:edits.json routes(saveRoute / deleteRoute),runner 用 routesPromptSection / routeTurnNote 注入。
 */
export interface RouteStep { id: string; pageId: string; action: string }
export interface RouteBranch { id: string; fromStepId: string; pageId: string; action: string; returnStepId: string }
export interface MemoryRoute { id: string; name: string; enabled: boolean; steps: RouteStep[]; branches: RouteBranch[]; updatedAt?: string }

/** 路線編輯中,點圖上的畫面要做什麼。 */
export type RoutePick = { kind: 'step' } | { kind: 'branch'; fromStepId: string };

const T = {
  title: ['操作路線', 'Routes'],
  desc: [
    'AI 每次測試都會照路線依序走(整個應用共用)。點「新增路線」後,依序點圖上的畫面,並寫下每一步要做什麼。某一步可能跳出活動彈窗之類的畫面時,用「+ 支線」畫一條岔路,告訴 AI 怎麼處理、處理完回到哪一步。',
    'The AI follows these routes in order on every run (shared across the app). Click “New route”, then click screens on the graph in order and write what to do at each step. If a step may hit something like a daily event popup, add a branch to tell the AI how to handle it and which step to go back to.',
  ],
  none: ['還沒有路線。', 'No routes yet.'],
  add: ['新增路線', 'New route'],
  edit: ['編輯', 'Edit'],
  del: ['刪除', 'Delete'],
  delConfirm: ['刪除路線「{name}」?', 'Delete route “{name}”?'],
  enabled: ['啟用', 'On'],
  steps: ['{n} 步', '{n} steps'],
  branches: ['{n} 條支線', '{n} branches'],
  name: ['路線名稱', 'Route name'],
  namePh: ['例:主線推關', 'e.g. Main stage run'],
  pickStep: ['👆 點圖上的畫面,加入第 {n} 步', '👆 Click a screen on the graph to add step {n}'],
  pickBranch: ['👆 點圖上的畫面當作第 {n} 步的支線(例如活動彈窗)', '👆 Click the screen that may pop up at step {n} (e.g. an event popup)'],
  pickCancel: ['改回加步驟', 'Back to adding steps'],
  actionPh: ['在這個畫面要做什麼(例:點選 xx 遊戲、除草殺敵直到通關)', 'What to do here (e.g. pick the game, fight until the stage is cleared)'],
  branchIf: ['若出現', 'If'],
  branchActionPh: ['怎麼處理(例:點右上角 X 關掉)', 'How to handle it (e.g. tap X at the top right)'],
  branchBack: ['然後回到第', 'then go back to step'],
  branchBackSuffix: ['步', ''],
  addBranch: ['+ 支線', '+ Branch'],
  up: ['上移', 'Move up'],
  down: ['下移', 'Move down'],
  remove: ['移除', 'Remove'],
  save: ['儲存路線', 'Save route'],
  saving: ['儲存中…', 'Saving…'],
  cancel: ['取消', 'Cancel'],
  needName: ['請填路線名稱', 'Please name the route'],
  needSteps: ['路線至少要有一步', 'Add at least one step'],
  missing: ['(畫面已刪除)', '(screen deleted)'],
  show: ['在圖上顯示', 'Show on graph'],
} as const;
export const rt = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];

const rand = () => (Math.random().toString(36).slice(2, 8) + Date.now().toString(36)).slice(0, 10);
export const newRouteId = () => `route-${rand()}`;
export const newStepId = () => `s-${rand()}`;
export const newBranchId = () => `b-${rand()}`;

export function emptyRoute(n: number, lang: RLang): MemoryRoute {
  return { id: newRouteId(), name: lang === 'zh' ? `路線 ${n}` : `Route ${n}`, enabled: true, steps: [], branches: [] };
}

/** 加一步(在圖上點畫面)。 */
export function addStep(r: MemoryRoute, pageId: string): MemoryRoute {
  return { ...r, steps: [...r.steps, { id: newStepId(), pageId, action: '' }] };
}
/** 加支線(在圖上點岔出去的畫面);預設處理完回到同一步。 */
export function addBranch(r: MemoryRoute, fromStepId: string, pageId: string): MemoryRoute {
  return { ...r, branches: [...r.branches, { id: newBranchId(), fromStepId, pageId, action: '', returnStepId: fromStepId }] };
}
/** 移除一步:連帶移除從它岔出去的支線;回到它的支線改回到所屬步驟。 */
export function removeStep(r: MemoryRoute, stepId: string): MemoryRoute {
  return {
    ...r,
    steps: r.steps.filter((s) => s.id !== stepId),
    branches: r.branches
      .filter((b) => b.fromStepId !== stepId)
      .map((b) => (b.returnStepId === stepId ? { ...b, returnStepId: b.fromStepId } : b)),
  };
}
export function moveStep(r: MemoryRoute, stepId: string, delta: -1 | 1): MemoryRoute {
  const i = r.steps.findIndex((s) => s.id === stepId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= r.steps.length) return r;
  const steps = [...r.steps];
  [steps[i], steps[j]] = [steps[j]!, steps[i]!];
  return { ...r, steps };
}

export function RoutesPanel({
  lang, routes, draft, pick, shownId, busy, pageName,
  onDraft, onPick, onShow, onSave, onCancel, onDelete, onToggle,
}: {
  lang: RLang;
  routes: MemoryRoute[];
  draft: MemoryRoute | null;
  pick: RoutePick | null;
  shownId: string | null;
  busy: boolean;
  pageName: (id: string) => string;
  onDraft: (r: MemoryRoute | null) => void;
  onPick: (p: RoutePick | null) => void;
  onShow: (id: string | null) => void;
  onSave: (r: MemoryRoute) => Promise<void>;
  onCancel: () => void;
  onDelete: (r: MemoryRoute) => Promise<void>;
  onToggle: (r: MemoryRoute) => Promise<void>;
}) {
  const [err, setErr] = useState('');
  const nm = (id: string) => pageName(id) || rt('missing', lang);

  if (draft) {
    const stepNo = new Map(draft.steps.map((s, i) => [s.id, i + 1]));
    const setStep = (id: string, action: string) => onDraft({ ...draft, steps: draft.steps.map((s) => (s.id === id ? { ...s, action } : s)) });
    const setBranch = (id: string, patch: Partial<RouteBranch>) => onDraft({ ...draft, branches: draft.branches.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
    const save = async () => {
      if (!draft.name.trim()) { setErr(rt('needName', lang)); return; }
      if (!draft.steps.length) { setErr(rt('needSteps', lang)); return; }
      setErr('');
      await onSave(draft);
    };
    return (
      <section className="routes routes--editing" aria-label={rt('title', lang)}>
        <div className="routes__edit-head">
          <label className="routes__name">
            <span>{rt('name', lang)}</span>
            <input value={draft.name} maxLength={40} placeholder={rt('namePh', lang)} onChange={(e) => onDraft({ ...draft, name: e.target.value })} />
          </label>
          <div className="routes__actions">
            <button type="button" className="sg-btn" onClick={onCancel} disabled={busy}>{rt('cancel', lang)}</button>
            <button type="button" className="sg-btn sg-btn--primary" onClick={() => void save()} disabled={busy}>{busy ? rt('saving', lang) : rt('save', lang)}</button>
          </div>
        </div>
        <ol className="routes__steps">
          {draft.steps.map((s, i) => (
            <li key={s.id} className="routes__step">
              <div className="routes__step-row">
                <span className="routes__num" aria-hidden="true">{i + 1}</span>
                <span className="routes__page">{nm(s.pageId)}</span>
                <input
                  className="routes__action"
                  value={s.action}
                  maxLength={200}
                  placeholder={rt('actionPh', lang)}
                  aria-label={`${i + 1}. ${nm(s.pageId)}`}
                  onChange={(e) => setStep(s.id, e.target.value)}
                />
                <button type="button" className="routes__icon" title={rt('up', lang)} aria-label={rt('up', lang)} disabled={i === 0} onClick={() => onDraft(moveStep(draft, s.id, -1))}>↑</button>
                <button type="button" className="routes__icon" title={rt('down', lang)} aria-label={rt('down', lang)} disabled={i === draft.steps.length - 1} onClick={() => onDraft(moveStep(draft, s.id, 1))}>↓</button>
                <button type="button" className="routes__icon routes__icon--danger" title={rt('remove', lang)} aria-label={rt('remove', lang)} onClick={() => onDraft(removeStep(draft, s.id))}>✕</button>
                <button
                  type="button"
                  className={`routes__branch-btn${pick?.kind === 'branch' && pick.fromStepId === s.id ? ' routes__branch-btn--active' : ''}`}
                  onClick={() => onPick({ kind: 'branch', fromStepId: s.id })}
                >
                  {rt('addBranch', lang)}
                </button>
              </div>
              {draft.branches.filter((b) => b.fromStepId === s.id).map((b) => (
                <div key={b.id} className="routes__branch">
                  <span className="routes__branch-mark" aria-hidden="true">↳</span>
                  <span>{rt('branchIf', lang)}「{nm(b.pageId)}」</span>
                  <input
                    className="routes__action"
                    value={b.action}
                    maxLength={200}
                    placeholder={rt('branchActionPh', lang)}
                    aria-label={`${rt('branchIf', lang)} ${nm(b.pageId)}`}
                    onChange={(e) => setBranch(b.id, { action: e.target.value })}
                  />
                  <label className="routes__back">
                    {rt('branchBack', lang)}
                    <select value={b.returnStepId} onChange={(e) => setBranch(b.id, { returnStepId: e.target.value })}>
                      {draft.steps.map((x) => <option key={x.id} value={x.id}>{stepNo.get(x.id)}</option>)}
                    </select>
                    {rt('branchBackSuffix', lang)}
                  </label>
                  <button type="button" className="routes__icon routes__icon--danger" title={rt('remove', lang)} aria-label={rt('remove', lang)} onClick={() => onDraft({ ...draft, branches: draft.branches.filter((x) => x.id !== b.id) })}>✕</button>
                </div>
              ))}
            </li>
          ))}
        </ol>
        <p className="routes__pick" role="status">
          {pick?.kind === 'branch'
            ? <>{rt('pickBranch', lang).replace('{n}', String(stepNo.get(pick.fromStepId) ?? '?'))} <button type="button" className="routes__link" onClick={() => onPick({ kind: 'step' })}>{rt('pickCancel', lang)}</button></>
            : rt('pickStep', lang).replace('{n}', String(draft.steps.length + 1))}
        </p>
        {err && <p className="sg-error" role="alert">{err}</p>}
      </section>
    );
  }

  return (
    <section className="routes" aria-label={rt('title', lang)}>
      <div className="routes__head">
        <h3 className="routes__title">{rt('title', lang)}</h3>
        <button type="button" className="sg-btn sg-btn--primary" disabled={busy} onClick={() => { onDraft(emptyRoute(routes.length + 1, lang)); onPick({ kind: 'step' }); }}>
          {rt('add', lang)}
        </button>
      </div>
      <p className="routes__desc">{rt('desc', lang)}</p>
      {routes.length === 0 ? (
        <p className="routes__none">{rt('none', lang)}</p>
      ) : (
        <ul className="routes__list">
          {routes.map((r) => (
            <li key={r.id} className={`routes__item${shownId === r.id ? ' routes__item--shown' : ''}${r.enabled ? '' : ' routes__item--off'}`}>
              <button type="button" className="routes__item-main" aria-pressed={shownId === r.id} title={rt('show', lang)} onClick={() => onShow(shownId === r.id ? null : r.id)}>
                <b>{r.name}</b>
                <span>{r.steps.map((s) => nm(s.pageId)).join(' → ')}</span>
                <small>
                  {rt('steps', lang).replace('{n}', String(r.steps.length))}
                  {r.branches.length > 0 && ` · ${rt('branches', lang).replace('{n}', String(r.branches.length))}`}
                </small>
              </button>
              <label className="routes__toggle">
                <input type="checkbox" checked={r.enabled} disabled={busy} onChange={() => void onToggle(r)} /> {rt('enabled', lang)}
              </label>
              <button type="button" className="routes__link" disabled={busy} onClick={() => { onDraft(r); onPick({ kind: 'step' }); onShow(r.id); }}>{rt('edit', lang)}</button>
              <button
                type="button"
                className="routes__link routes__link--danger"
                disabled={busy}
                onClick={() => { if (window.confirm(rt('delConfirm', lang).replace('{name}', r.name))) void onDelete(r); }}
              >
                {rt('del', lang)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
