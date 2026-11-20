import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { apiDelete, apiGet, apiPost, type ListResponse } from '../../api/client.ts';
import type { RLang } from '../report/reportText.ts';
import { recommendStyle, sortByRecommend, starLabel } from '../modelRecommend.ts';
import { InfoIcon } from './InfoIcon.tsx';
import { pick5 } from '../../i18n/locale5.ts';
import './TaskAskPanel.css';
import { formatPerM, regionalSuffix, type ModelPricing } from '../modelPrice.ts';

/** GET /models?seat=ask 的一筆(管理員在模型管理「AI 問答」欄開放的模型)。 */
interface AskModel {
  modelId: string;
  displayName: string;
  unavailable?: string;
  recommended?: boolean;
  pricing?: ModelPricing;
}
const MODEL_PREF_KEY = 'pa.taskAsk.model';

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
  title: ['AI 問答', 'Ask AI', 'AI 问答', 'AI に質問', 'AI에게 질문'],
  hint: ['AI 會根據這次任務的執行步驟、裝置 log、知識庫與報告回答。', 'Answers use this run’s steps, device logs, knowledge base and report.', 'AI 会根据这次任务的运行步骤、设备 log、知识库与报告回答。', 'AI はこのタスクの実行ステップ、デバイスログ、ナレッジベース、レポートに基づいて回答します。', 'AI는 이 작업의 실행 단계, 기기 로그, 지식 베이스, 보고서를 바탕으로 답변합니다.'],
  placeholder: ['問這次測試的問題,例:根據目前收集到的 log 有什麼需要我注意的?(Enter 送出,Shift+Enter 換行)', 'Ask about this run, e.g. “Anything in the logs I should watch out for?” (Enter to send, Shift+Enter for a new line)', '问这次测试的问题,例:根据目前收集到的 log 有什么需要我注意的?(Enter 送出,Shift+Enter 换行)', 'このテストについて質問してください。例:現在収集されたログで注意すべき点は?(Enter で送信、Shift+Enter で改行)', '이번 테스트에 대해 질문하세요. 예: 지금까지 수집된 로그에서 주의할 점은? (Enter로 전송, Shift+Enter로 줄바꿈)'],
  send: ['送出', 'Send', '送出', '送信', '전송'],
  thinking: ['AI 分析中…(約 10–20 秒)', 'Analysing… (about 10–20 s)', 'AI 分析中…(约 10–20 秒)', 'AI が分析中…(約 10〜20 秒)', 'AI 분석 중…(약 10~20초)'],
  clear: ['清空對話', 'Clear', '清空对话', '会話をクリア', '대화 지우기'],
  clearConfirm: ['清空這個任務的 AI 問答紀錄?', 'Clear this task’s Q&A history?', '清空这个任务的 AI 问答纪录?', 'このタスクの AI Q&A 履歴をクリアしますか?', '이 작업의 AI 질문·답변 기록을 지우시겠습니까?'],
  failed: ['問答失敗:', 'Failed: ', '问答失败:', 'Q&A に失敗しました:', '질문·답변 실패:'],
  you: ['你', 'You', '你', 'あなた', '나'],
  ai: ['AI', 'AI', 'AI', 'AI', 'AI'],
  collapse: ['收合', 'Collapse', '收合', '折りたたむ', '접기'],
  expand: ['展開', 'Expand', '展开', '展開', '펼치기'],
  q1: ['根據目前收集到的 log,有什麼需要我注意的?', 'Based on the logs so far, what should I watch out for?', '根据目前收集到的 log,有什么需要我注意的?', '現在収集されたログで、注意すべき点は?', '지금까지 수집된 로그에서 주의할 점은 무엇인가요?'],
  q2: ['這次測試為什麼失敗 / 卡住?', 'Why did this run fail or get stuck?', '这次测试为什么失败 / 卡住?', 'このテストはなぜ失敗した / 止まったのですか?', '이 테스트는 왜 실패했거나 멈췄나요?'],
  q3: ['AI 有沒有照測試腳本走?哪一步偏離了?', 'Did the AI follow the script? Where did it deviate?', 'AI 有没有照测试脚本走?哪一步偏离了?', 'AI はテストスクリプトどおりに進みましたか?どのステップでずれましたか?', 'AI가 테스트 스크립트대로 진행했나요? 어느 단계에서 벗어났나요?'],
  q4: ['有沒有當機、ANR 或錯誤訊息?', 'Any crashes, ANRs or error messages?', '有没有当机、ANR 或错误消息?', 'クラッシュ、ANR、エラーメッセージはありましたか?', '크래시, ANR, 오류 메시지가 있었나요?'],
  model: ['問答模型', 'Model', '问答模型', 'Q&A モデル', '질문·답변 모델'],
  more: ['你也可以問', 'You can also ask', '你也可以问', 'こんな質問もできます', '이런 질문도 할 수 있습니다'],
  gotoStep: ['在時間軸跳到第 {n} 步', 'Jump to step {n} on the timeline', '在时间轴跳到第 {n} 步', 'タイムラインでステップ {n} へ移動', '타임라인에서 {n}단계로 이동'],
  placeholderShort: ['問這次測試的問題,例如:哪一步最花時間?(Enter 送出)', 'Ask about this run, e.g. which step took longest? (Enter to send)', '问这次测试的问题,例如:哪一步最花时间?(Enter 送出)', 'このテストについて質問してください。例:最も時間がかかったステップは?(Enter で送信)', '이번 테스트에 대해 질문하세요. 예: 가장 오래 걸린 단계는? (Enter로 전송)'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => pick5(T[k], lang);

/** 回答裡的「#3」「第 3 步」變成可點的連結(點了時間軸跳到那一步)。 */
const STEP_REF = /#(\d+)|第\s*(\d+)\s*步/g;
function withStepLinks(text: string, onStep: ((n: number) => void) | undefined, lang: RLang) {
  if (!onStep) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(STEP_REF)) {
    const n = Number(m[1] ?? m[2]);
    if (!Number.isFinite(n)) continue;
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(
      <button key={m.index} type="button" className="taskask__ref" title={tx('gotoStep', lang).replace('{n}', String(n))} onClick={() => onStep(n)}>
        {m[0]}
      </button>,
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function TaskAskPanel({ jobId, lang, embedded = false, onStep }: {
  jobId: string;
  lang: RLang;
  /** 放在任務詳情的分頁裡:不顯示可收合的標題列,建議問題固定在輸入框上方。 */
  embedded?: boolean;
  /** 回答裡提到的步驟 → 時間軸跳過去。 */
  onStep?: (index: number) => void;
}) {
  const [items, setItems] = useState<AskMessage[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const [models, setModels] = useState<AskModel[]>([]);
  const [model, setModel] = useState('');
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let stale = false;
    apiGet<{ items: AskMessage[] }>(`/tasks/${encodeURIComponent(jobId)}/ask`)
      .then((r) => { if (!stale) setItems(r.items ?? []); })
      .catch(() => {});
    return () => { stale = true; };
  }, [jobId]);

  // 可選的問答模型:依模型管理「AI 問答」欄;預設 = 上次選的 → 推薦(金勾勾)→ 第一個。
  useEffect(() => {
    let stale = false;
    apiGet<ListResponse<AskModel>>('/models?seat=ask')
      .then((r) => {
        if (stale) return;
        const list = sortByRecommend('agent', r.items.filter((m) => !m.unavailable));
        setModels(list);
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(MODEL_PREF_KEY) : null;
        setModel(list.find((m) => m.modelId === saved)?.modelId ?? list.find((m) => m.recommended)?.modelId ?? list[0]?.modelId ?? '');
      })
      .catch(() => {});
    return () => { stale = true; };
  }, []);
  function pickModel(id: string) {
    setModel(id);
    try { localStorage.setItem(MODEL_PREF_KEY, id); } catch { /* 無痕模式等 */ }
  }
  const modelName = (id?: string) => (id ? models.find((m) => m.modelId === id)?.displayName ?? id.replace(/^(us|global)\./, '') : '');
  const optionLabel = (m: AskModel) => {
    if (!m.pricing) return m.displayName;
    const f = formatPerM;
    return `${m.displayName} — ${f(m.pricing.inputPerM)}/${f(m.pricing.outputPerM)}${m.pricing.estimated ? '*' : ''}${regionalSuffix(m.pricing, lang)}`;
  };

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
      const r = await apiPost<{ items: AskMessage[] }>(`/tasks/${encodeURIComponent(jobId)}/ask`, { question: text, lang, ...(model ? { modelId: model } : {}) });
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

  const shown = embedded || open;
  const suggestions = (['q1', 'q2', 'q3', 'q4'] as const).map((k) => (
    <button key={k} type="button" className="taskask__chip" onClick={() => void ask(tx(k, lang))} disabled={busy}>{tx(k, lang)}</button>
  ));
  return (
    <section className={`taskask${shown ? '' : ' taskask--closed'}${embedded ? ' taskask--embedded' : ''}${items.length ? ' has-items' : ''}`} aria-labelledby="taskask-title">
      {embedded ? (
        <h3 id="taskask-title" className="visually-hidden">{tx('title', lang)}</h3>
      ) : (
        <div className="taskask__head">
          <button type="button" className="taskask__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <InfoIcon name={open ? 'chevDown' : 'chevRight'} size={14} />
            <h3 id="taskask-title"><InfoIcon name="sparkle" size={15} /> {tx('title', lang)}</h3>
          </button>
          {open && items.length > 0 && (
            <button type="button" className="taskask__clear" onClick={() => void clear()} disabled={busy}>{tx('clear', lang)}</button>
          )}
        </div>
      )}
      {shown && (
        <>
          {items.length === 0 && !busy ? (
            <div className="taskask__empty">
              <p className="taskask__intro">
                <span className="taskask__avatar"><InfoIcon name="sparkle" size={15} /></span>
                {tx('hint', lang)}
              </p>
              {!embedded && <div className="taskask__chips">{suggestions}</div>}
            </div>
          ) : (
            <ol className="taskask__list" ref={listRef} aria-live="polite">
              {items.map((m, i) => (
                <li key={i} className={`taskask__msg taskask__msg--${m.role}`}>
                  {m.role === 'assistant' && <span className="taskask__avatar" aria-hidden="true"><InfoIcon name="sparkle" size={14} /></span>}
                  <div className="taskask__bubble">
                    <span className="taskask__who">
                      {m.role === 'user' ? tx('you', lang) : tx('ai', lang)}
                      {m.role === 'assistant' && m.model && <span className="taskask__model"> · {modelName(m.model)}</span>}
                    </span>
                    <div className="taskask__text">{m.role === 'assistant' ? withStepLinks(m.text, onStep, lang) : m.text}</div>
                  </div>
                </li>
              ))}
              {busy && (
                <li className="taskask__msg taskask__msg--assistant taskask__msg--busy" role="status">
                  <span className="taskask__avatar" aria-hidden="true"><InfoIcon name="sparkle" size={14} /></span>
                  <div className="taskask__bubble">
                    <span className="taskask__who">{tx('ai', lang)}</span>
                    <div className="taskask__text">{tx('thinking', lang)}</div>
                  </div>
                </li>
              )}
            </ol>
          )}
          {error && <p className="taskask__error" role="alert">{error}</p>}
          {embedded && (
            <div className="taskask__suggest" role="group" aria-label={tx('more', lang)}>
              <span className="taskask__suggest-k">{tx('more', lang)}</span>
              {suggestions}
            </div>
          )}
          <form className="taskask__form" onSubmit={onSubmit}>
            <textarea
              value={q}
              rows={embedded ? 1 : 2}
              maxLength={1000}
              placeholder={tx(embedded ? 'placeholderShort' : 'placeholder', lang)}
              aria-label={tx('title', lang)}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              disabled={busy}
            />
            <button type="submit" className="taskask__send" disabled={busy || !q.trim()} aria-label={tx('send', lang)} title={tx('send', lang)}>
              {embedded ? <InfoIcon name="send" size={16} /> : tx('send', lang)}
            </button>
          </form>
          {(models.length > 0 || (embedded && items.length > 0)) && (
            <div className="taskask__foot">
              {models.length > 0 && (
                <label className="taskask__modelpick">
                  {embedded ? <InfoIcon name="cpu" size={13} /> : null}
                  <span className={embedded ? 'visually-hidden' : undefined}>{tx('model', lang)}</span>
                  <select value={model} onChange={(e) => pickModel(e.target.value)} disabled={busy}>
                    {models.map((m) => (
                      <option key={m.modelId} value={m.modelId} style={recommendStyle(m)}>{starLabel('agent', m, optionLabel(m))}</option>
                    ))}
                  </select>
                </label>
              )}
              {embedded && items.length > 0 && (
                <button type="button" className="taskask__clear" onClick={() => void clear()} disabled={busy} title={tx('clear', lang)}>
                  <InfoIcon name="trash" size={13} /> {tx('clear', lang)}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
