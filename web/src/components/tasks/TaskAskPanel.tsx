import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { apiDelete, apiGet, apiPost } from '../../api/client.ts';
import type { RLang } from '../report/reportText.ts';
import './TaskAskPanel.css';

/**
 * 任務 AI 問答:針對這一次任務發問,AI 依任務的步驟、裝置 log、知識庫、報告回答。
 * 後端:GET/POST/DELETE /tasks/{id}/ask(infra/lambda/api/taskAsk.ts);對話存在任務資料夾,重新整理後還在。
 */
interface AskMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  model?: string;
}

const T = {
  title: ['AI 問答', 'Ask AI'],
  hint: ['AI 會根據這次任務的執行步驟、裝置 log、知識庫與報告回答。', 'Answers use this run’s steps, device logs, knowledge base and report.'],
  placeholder: ['問這次測試的問題,例:根據目前收集到的 log 有什麼需要我注意的?(Enter 送出,Shift+Enter 換行)', 'Ask about this run, e.g. “Anything in the logs I should watch out for?” (Enter to send, Shift+Enter for a new line)'],
  send: ['送出', 'Send'],
  thinking: ['AI 分析中…(約 10–20 秒)', 'Analysing… (about 10–20 s)'],
  clear: ['清空對話', 'Clear'],
  clearConfirm: ['清空這個任務的 AI 問答紀錄?', 'Clear this task’s Q&A history?'],
  failed: ['問答失敗:', 'Failed: '],
  you: ['你', 'You'],
  ai: ['AI', 'AI'],
  collapse: ['收合', 'Collapse'],
  expand: ['展開', 'Expand'],
  q1: ['根據目前收集到的 log,有什麼需要我注意的?', 'Based on the logs so far, what should I watch out for?'],
  q2: ['這次測試為什麼失敗 / 卡住?', 'Why did this run fail or get stuck?'],
  q3: ['AI 有沒有照測試腳本走?哪一步偏離了?', 'Did the AI follow the script? Where did it deviate?'],
  q4: ['有沒有當機、ANR 或錯誤訊息?', 'Any crashes, ANRs or error messages?'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];

export function TaskAskPanel({ jobId, lang }: { jobId: string; lang: RLang }) {
  const [items, setItems] = useState<AskMessage[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let stale = false;
    apiGet<{ items: AskMessage[] }>(`/tasks/${encodeURIComponent(jobId)}/ask`)
      .then((r) => { if (!stale) setItems(r.items ?? []); })
      .catch(() => {});
    return () => { stale = true; };
  }, [jobId]);

  // 新訊息 / 分析中時捲到底。
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, busy, open]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    // 先把問題放上去(樂觀顯示),回應後以伺服器的完整對話為準。
    setItems((prev) => [...prev, { role: 'user', text, at: new Date().toISOString() }]);
    setQ('');
    try {
      const r = await apiPost<{ items: AskMessage[] }>(`/tasks/${encodeURIComponent(jobId)}/ask`, { question: text, lang });
      setItems(r.items ?? []);
    } catch (err) {
      setError(`${tx('failed', lang)}${err instanceof Error ? err.message : String(err)}`);
      setItems((prev) => prev.slice(0, -1));
      setQ(text);
    } finally {
      setBusy(false);
    }
  }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void ask(q); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(q); }
  };
  async function clear() {
    if (!window.confirm(tx('clearConfirm', lang))) return;
    await apiDelete(`/tasks/${encodeURIComponent(jobId)}/ask`).catch(() => {});
    setItems([]);
  }

  return (
    <section className={`taskask${open ? '' : ' taskask--closed'}`} aria-labelledby="taskask-title">
      <div className="taskask__head">
        <button type="button" className="taskask__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <h3 id="taskask-title">✨ {tx('title', lang)}</h3>
        </button>
        {open && items.length > 0 && (
          <button type="button" className="taskask__clear" onClick={() => void clear()} disabled={busy}>{tx('clear', lang)}</button>
        )}
      </div>
      {open && (
        <>
          {items.length === 0 && !busy ? (
            <div className="taskask__empty">
              <p>{tx('hint', lang)}</p>
              <div className="taskask__chips">
                {(['q1', 'q2', 'q3', 'q4'] as const).map((k) => (
                  <button key={k} type="button" className="taskask__chip" onClick={() => void ask(tx(k, lang))}>{tx(k, lang)}</button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="taskask__list" ref={listRef} aria-live="polite">
              {items.map((m, i) => (
                <li key={i} className={`taskask__msg taskask__msg--${m.role}`}>
                  <span className="taskask__who">{m.role === 'user' ? tx('you', lang) : tx('ai', lang)}</span>
                  <div className="taskask__text">{m.text}</div>
                </li>
              ))}
              {busy && (
                <li className="taskask__msg taskask__msg--assistant taskask__msg--busy" role="status">
                  <span className="taskask__who">{tx('ai', lang)}</span>
                  <div className="taskask__text">{tx('thinking', lang)}</div>
                </li>
              )}
            </ol>
          )}
          {error && <p className="taskask__error" role="alert">{error}</p>}
          <form className="taskask__form" onSubmit={onSubmit}>
            <textarea
              value={q}
              rows={2}
              maxLength={1000}
              placeholder={tx('placeholder', lang)}
              aria-label={tx('title', lang)}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              disabled={busy}
            />
            <button type="submit" className="taskask__send" disabled={busy || !q.trim()}>{tx('send', lang)}</button>
          </form>
        </>
      )}
    </section>
  );
}
