import { useMemo, useState, type MouseEvent } from 'react';
import { apiPost } from '../../api/client.ts';
import type { RLang } from '../report/reportText.ts';
import {
  edgeOpKey,
  effectiveOp,
  exportFileName,
  findScriptPath,
  generateAppiumScript,
  MIN_HITS,
  opTrust,
  popupHandlers,
  selfOpKey,
  spinOpOf,
  type MemOp,
  type OpEdit,
  type ScriptEdge,
  type ScriptPage,
  type SelfOp,
  type Trust,
} from './memoryScript.ts';

const T = {
  title: ['記憶腳本 · 這個畫面的操作', 'Memory script · actions on this screen'],
  desc: [
    'AI 在這個畫面做過的操作與實際位置。成功 2 次以上且沒失敗、或你按「確認」的,下次測試會直接照做(不問 AI,快很多);位置不對可以修正。',
    'What the AI did on this screen and where. Actions with 2+ successes and no failures, or ones you confirm, are replayed directly next run (no AI call, much faster). Fix the position if it is off.',
  ],
  empty: ['還沒有記錄到操作。跑過測試之後就會出現。', 'No actions recorded yet. They appear after a run.'],
  sameScreen: ['同一畫面', 'Same screen'],
  verified: ['✔ 已確認 · 會直接執行', '✔ Confirmed · replayed'],
  auto: ['⚡ 會直接執行(成功 {n} 次)', '⚡ Replayed ({n} successes)'],
  learning: ['學習中(成功 {n}/{min})', 'Learning ({n}/{min} successes)'],
  learningMiss: ['學習中(有失敗紀錄,需確認)', 'Learning (has failures; confirm to use)'],
  disabled: ['已停用', 'Disabled'],
  noOp: ['沒有位置紀錄(舊資料)', 'No position recorded (older data)'],
  confirm: ['確認', 'Confirm'],
  unconfirm: ['取消確認', 'Unconfirm'],
  disable: ['停用', 'Disable'],
  enable: ['啟用', 'Enable'],
  fix: ['修正位置', 'Fix position'],
  fixing: ['點截圖上的正確位置…', 'Click the right spot on the screenshot…'],
  fixCancel: ['取消', 'Cancel'],
  reset: ['還原記錄值', 'Reset'],
  edited: ['已修正', 'Edited'],
  xPct: ['X(%)', 'X (%)'],
  yPct: ['Y(%)', 'Y (%)'],
  save: ['儲存', 'Save'],
  export: ['匯出 Appium 腳本(從起點到這個畫面)', 'Export Appium script (start → this screen)'],
  exportHint: [
    '下載一個 WebdriverIO 腳本,在你的電腦用 Appium 照記憶走到這個畫面(每步先比對畫面才點,途中自動關掉已知彈窗)。',
    'Downloads a WebdriverIO script that replays the path to this screen with Appium on your machine (checks each screen before tapping, closes known popups).',
  ],
  exportNone: ['還沒有從起點到這裡、而且記得位置的路徑。', 'No recorded path with positions from the start to here yet.'],
  exportDone: ['已下載:{f}({n} 步)', 'Downloaded: {f} ({n} steps)'],
  failed: ['操作失敗:', 'Failed: '],
  action: { tap: ['點擊', 'Tap'], swipe: ['滑動', 'Swipe'], hold: ['長按', 'Hold'], back: ['返回', 'Back'], type: ['輸入', 'Type'], key: ['按鍵', 'Key'], move: ['搖桿', 'Joystick'] },
} as const;
type Key = Exclude<keyof typeof T, 'action'>;
const tx = (k: Key, lang: RLang, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce<string>((s, [n, v]) => s.replace(`{${n}}`, String(v)), T[k][lang === 'zh' ? 0 : 1]);
const actName = (a: string, lang: RLang) => (T.action as Record<string, readonly [string, string]>)[a]?.[lang === 'zh' ? 0 : 1] ?? a;

interface Item {
  key: string;
  kind: string;
  target: string;
  to: string | null;
  hitCount: number;
  missCount: number;
  op?: MemOp;
  trust: Trust;
  edit?: OpEdit;
}

function trustText(it: Item, lang: RLang): string {
  if (!it.op) return tx('noOp', lang);
  if (it.trust === 'verified') return tx('verified', lang);
  if (it.trust === 'auto') return tx('auto', lang, { n: it.hitCount });
  if (it.trust === 'disabled') return tx('disabled', lang);
  return it.missCount > 0 ? tx('learningMiss', lang) : tx('learning', lang, { n: it.hitCount, min: MIN_HITS });
}

export function MemoryOpsSection({
  lang,
  appId,
  appName,
  pageId,
  screenshotUrl,
  pages,
  edges,
  rootPageId,
  opEdits,
  pageName,
  onEdited,
}: {
  lang: RLang;
  appId: string;
  appName?: string;
  pageId: string;
  screenshotUrl?: string;
  pages: Record<string, ScriptPage>;
  edges: ScriptEdge[];
  rootPageId?: string | null;
  opEdits: Record<string, OpEdit>;
  pageName: (id: string) => string;
  onEdited: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixKey, setFixKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ x: string; y: string }>({ x: '', y: '' });
  const [note, setNote] = useState<string | null>(null);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const e of edges.filter((x) => x.fromPageId === pageId && x.trigger?.kind && x.trigger.kind !== 'auto')) {
      const key = edgeOpKey(e);
      const edit = opEdits[key];
      out.push({
        key, kind: e.trigger!.kind!, target: e.trigger?.target ?? '', to: e.toPageId,
        hitCount: e.hitCount, missCount: e.missCount, trust: opTrust(e, edit), ...(edit ? { edit } : {}),
        ...(effectiveOp(e.op, edit) ? { op: effectiveOp(e.op, edit)! } : {}),
      });
    }
    for (const s of (pages[pageId]?.selfOps ?? []) as SelfOp[]) {
      const key = selfOpKey(pageId, s);
      const edit = opEdits[key];
      out.push({
        key, kind: s.kind, target: s.target, to: null, hitCount: s.hitCount, missCount: s.missCount,
        trust: opTrust(s, edit), ...(edit ? { edit } : {}),
        ...(effectiveOp(s.op, edit) ? { op: effectiveOp(s.op, edit)! } : {}),
      });
    }
    return out;
  }, [edges, pages, pageId, opEdits]);

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await apiPost('/memory/edit', { app: appId, ...body });
      onEdited();
    } catch (err) {
      setError(`${tx('failed', lang)}${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function startFix(it: Item) {
    setFixKey(it.key);
    setDraft({ x: String(Math.round((it.op?.x ?? 0.5) * 100)), y: String(Math.round((it.op?.y ?? 0.5) * 100)) });
  }
  async function saveFix(it: Item, x: number, y: number) {
    if (!it.op) return;
    const clamp = (v: number) => Math.max(0, Math.min(1, Math.round(v * 10000) / 10000));
    await save({ op: 'setOp', key: it.key, opData: { ...it.op, x: clamp(x), y: clamp(y) } });
    setFixKey(null);
  }
  function onShotClick(e: MouseEvent<HTMLDivElement>) {
    const it = items.find((x) => x.key === fixKey);
    if (!it) return;
    const r = e.currentTarget.getBoundingClientRect();
    void saveFix(it, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }

  function onExport() {
    setNote(null);
    const steps = findScriptPath(pages, edges, opEdits, pageId, rootPageId);
    if (!steps) { setNote(tx('exportNone', lang)); return; }
    const p = pages[pageId];
    const target = { id: pageId, name: p?.name ?? pageId, hashes: [...new Set([p?.pHash, ...(p?.pHashes ?? [])].filter((h): h is string => Boolean(h)))] };
    const text = generateAppiumScript({
      appId, ...(appName ? { appName } : {}), steps, target,
      handlers: popupHandlers(pages, edges, opEdits), spin: spinOpOf(p, opEdits),
    });
    const file = exportFileName(appId, target.name);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNote(tx('exportDone', lang, { f: file, n: steps.length }));
  }

  const marked = items.map((it, i) => ({ it, n: i + 1 })).filter(({ it }) => it.op && Number.isFinite(it.op.x) && Number.isFinite(it.op.y));

  return (
    <section className="memedit__section memops">
      <h3 className="memedit__subtitle">{tx('title', lang)}</h3>
      <p className="memedit__desc">{tx('desc', lang)}</p>
      {screenshotUrl && (
        <div
          className={`memops__shot${fixKey ? ' is-picking' : ''}`}
          onClick={fixKey ? onShotClick : undefined}
          role={fixKey ? 'button' : undefined}
          aria-label={fixKey ? tx('fixing', lang) : undefined}
        >
          <img src={screenshotUrl} alt={pageName(pageId)} />
          {marked.map(({ it, n }) => (
            <span
              key={it.key}
              className={`memops__dot memops__dot--${it.trust}${fixKey === it.key ? ' is-active' : ''}`}
              style={{ left: `${(it.op!.x ?? 0) * 100}%`, top: `${(it.op!.y ?? 0) * 100}%` }}
              aria-hidden="true"
            >
              {n}
            </span>
          ))}
          {marked.filter(({ it }) => it.op?.a === 'swipe').map(({ it }) => (
            <span
              key={`${it.key}-end`}
              className="memops__dot memops__dot--end"
              style={{ left: `${(it.op!.x2 ?? 0) * 100}%`, top: `${(it.op!.y2 ?? 0) * 100}%` }}
              aria-hidden="true"
            >
              ↘
            </span>
          ))}
        </div>
      )}
      {fixKey && <p className="memedit__muted" role="status">{tx('fixing', lang)}</p>}
      {items.length === 0 ? (
        <p className="memedit__empty">{tx('empty', lang)}</p>
      ) : (
        <ol className="memedit__edges memops__list">
          {items.map((it) => (
            <li key={it.key} className={`memedit__edge memops__item memops__item--${it.trust}`}>
              <div className="memedit__edge-body">
                <span className="memedit__edge-to">
                  {actName(it.kind, lang)}{it.target ? `「${it.target}」` : ''} → {it.to ? pageName(it.to) : tx('sameScreen', lang)}
                </span>
                <span className="memedit__muted">
                  {trustText(it, lang)}
                  {it.op && Number.isFinite(it.op.x) ? ` · (${Math.round((it.op.x ?? 0) * 100)}%, ${Math.round((it.op.y ?? 0) * 100)}%)` : ''}
                  {it.edit?.op ? ` · ${tx('edited', lang)}` : ''}
                </span>
                {fixKey === it.key && (
                  <form
                    className="memedit__actions memops__fix"
                    onSubmit={(e) => { e.preventDefault(); void saveFix(it, Number(draft.x) / 100, Number(draft.y) / 100); }}
                  >
                    <label>{tx('xPct', lang)} <input type="number" min={0} max={100} value={draft.x} onChange={(e) => setDraft({ ...draft, x: e.target.value })} /></label>
                    <label>{tx('yPct', lang)} <input type="number" min={0} max={100} value={draft.y} onChange={(e) => setDraft({ ...draft, y: e.target.value })} /></label>
                    <button type="submit" className="memedit__btn" disabled={busy}>{tx('save', lang)}</button>
                    <button type="button" className="memedit__link" onClick={() => setFixKey(null)}>{tx('fixCancel', lang)}</button>
                  </form>
                )}
              </div>
              <div className="memops__btns">
                {it.op && it.trust !== 'verified' && it.trust !== 'disabled' && (
                  <button type="button" className="memedit__link" disabled={busy} onClick={() => void save({ op: 'setOp', key: it.key, verified: true })}>{tx('confirm', lang)}</button>
                )}
                {it.trust === 'verified' && (
                  <button type="button" className="memedit__link" disabled={busy} onClick={() => void save({ op: 'setOp', key: it.key, verified: false })}>{tx('unconfirm', lang)}</button>
                )}
                {it.trust === 'disabled' ? (
                  <button type="button" className="memedit__link" disabled={busy} onClick={() => void save({ op: 'setOp', key: it.key, disabled: false })}>{tx('enable', lang)}</button>
                ) : (
                  <button type="button" className="memedit__link memedit__link--danger" disabled={busy} onClick={() => void save({ op: 'setOp', key: it.key, disabled: true })}>{tx('disable', lang)}</button>
                )}
                {it.op && (it.op.a === 'tap' || it.op.a === 'hold' || it.op.a === 'swipe') && fixKey !== it.key && (
                  <button type="button" className="memedit__link" disabled={busy} onClick={() => startFix(it)}>{tx('fix', lang)}</button>
                )}
                {it.edit && (
                  <button type="button" className="memedit__link" disabled={busy} onClick={() => void save({ op: 'clearOp', key: it.key })}>{tx('reset', lang)}</button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="memops__export">
        <button type="button" className="memedit__btn" onClick={onExport}>{tx('export', lang)}</button>
        <p className="memedit__muted">{tx('exportHint', lang)}</p>
        {note && <p className="memedit__muted" role="status">{note}</p>}
      </div>
      {error && <p className="memedit__error" role="alert">{error}</p>}
    </section>
  );
}
