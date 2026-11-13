import { useEffect, useMemo, useRef, useState } from 'react';
import type { RLang } from '../report/reportText.ts';
import { SILENT_DB } from './audioLevels.ts';
import { DECIDER_ICON, KIND_ICON, SEAT_ICON, eventHue, eventIcon } from './eventIcons.ts';
import { DEFAULT_FILTER, FEED_KINDS, applyFilter, feedCounts, type FeedEvent, type FeedFilter, type FeedKind } from './feed.ts';
import { InfoIcon } from './InfoIcon.tsx';
import { memoryChips, type StepMemory } from './memoryUsage.ts';
import { fmtClock, lastAtOrBefore, levelAt, stepAt, tracesAt, type Timeline } from './timeline.ts';
import { pick5 } from '../../i18n/locale5.ts';
import './MomentFeed.css';

/**
 * 「即時訊息」:播放頭當下發生了什麼(步驟 / AI / 記憶 / 腳本 / 裝置 log / 音效 / 指令),
 * 用類別 → 類型 → tag → 關鍵字 → 範圍一層一層過濾。點時間 = 時間軸跳到那一刻;點 tag / 類型 = 再往下過濾。
 * icon 與顏色跟時間軸同一套(eventIcons.ts)。
 */

const T = {
  beforeFirst: ['第一步之前', 'Before the first step', '第一步之前', '最初のステップの前', '첫 단계 이전'],
  rel: ['第 {n} 步開始後 +{s} 秒', '+{s} s into step {n}', '第 {n} 步开始后 +{s} 秒', 'ステップ {n} の開始から +{s} 秒', '{n}단계 시작 후 +{s}초'],
  silent: ['靜音', 'Silent', '静音', '無音', '무음'],
  noRec: ['沒有錄音', 'No recording', '没有录音', '録音なし', '녹음 없음'],
  k_step: ['步驟', 'Steps', '步骤', 'ステップ', '단계'],
  k_ai: ['AI', 'AI', 'AI', 'AI', 'AI'],
  k_memory: ['記憶', 'Memory', '记忆', 'メモリ', '메모리'],
  k_script: ['腳本', 'Script', '脚本', 'スクリプト', '스크립트'],
  k_log: ['裝置 Log', 'Device log', '设备 Log', 'デバイスログ', '기기 로그'],
  k_sound: ['音效', 'Sound', '音效', 'サウンド', '사운드'],
  k_operator: ['指令', 'Commands', '指令', '指示', '지시'],
  s_agent: ['決策 Agent', 'Decision agent', '决策 Agent', '判断エージェント', '판단 에이전트'],
  s_vision: ['視覺 Agent', 'Vision agent', '视觉 Agent', 'ビジョンエージェント', '비전 에이전트'],
  s_reflex: ['照記憶', 'From memory', '照记忆', 'メモリから', '메모리 기반'],
  s_operator: ['測試人員', 'Tester', '测试人员', 'テスター', '테스터'],
  s_vlm: ['視覺', 'Vision', '视觉', 'ビジョン', '비전'],
  s_subagent: ['輔助', 'Helper', '辅助', '補助', '보조'],
  s_known: ['已知畫面', 'Known screen', '已知画面', '既知の画面', '알려진 화면'],
  s_learned: ['本次見過', 'Seen this run', '本次见过', '今回確認済み', '이번에 확인됨'],
  s_new: ['新畫面', 'New screen', '新画面', '新しい画面', '새 화면'],
  s_followed: ['預測應驗', 'Prediction held', '预测应验', '予測どおり', '예측 적중'],
  s_diverged: ['與記憶不符', 'Differs', '与记忆不符', 'メモリと不一致', '기억과 불일치'],
  s_no_effect: ['沒反應', 'No effect', '没反应', '反応なし', '반응 없음'],
  s_plan: ['照已驗證路徑', 'Verified path', '照已验证路径', '検証済みの経路', '검증된 경로'],
  s_hint: ['教學', 'Tips', '教学', 'ヒント', '가르침'],
  s_route: ['路線', 'Route', '路线', 'ルート', '경로'],
  s_progress: ['腳本進度', 'Progress', '脚本进度', 'スクリプト進捗', '스크립트 진행'],
  s_goal: ['目標', 'Goal', '目标', '目標', '목표'],
  s_command: ['文字指令', 'Typed', '文本指令', 'テキスト指示', '텍스트 지시'],
  s_gesture: ['直接操作', 'Gesture', '直接操作', '直接操作', '직접 조작'],
  s_game: ['遊戲音效', 'Game sound', '游戏音效', 'ゲームサウンド', '게임 사운드'],
  s_fail: ['播放失敗', 'Failed', '播放失败', '再生失敗', '재생 실패'],
  s_onset: ['錄到聲音', 'Heard', '录到声音', '音声を検出', '소리 감지'],
  s_stream: ['系統聲音', 'System audio', '系统声音', 'システム音', '시스템 소리'],
  s_V: ['詳細', 'Verbose', '详细', '詳細', '상세'],
  s_D: ['除錯', 'Debug', '调试', 'デバッグ', '디버그'],
  s_I: ['資訊', 'Info', '信息', '情報', '정보'],
  s_W: ['警告', 'Warning', '警告', '警告', '경고'],
  s_E: ['錯誤', 'Error', '错误', 'エラー', '오류'],
  kinds: ['事件類別', 'Event kinds', '事件类别', 'イベント種別', '이벤트 종류'],
  kindTip: ['{k} · {n} 筆', '{k} · {n}', '{k} · {n} 笔', '{k} · {n} 件', '{k} · {n}건'],
  kindOff: ['已隱藏,點一下顯示', 'hidden, click to show', '已隐藏,点一下显示', '非表示です。クリックで表示', '숨김, 클릭하여 표시'],
  filters: ['篩選', 'Filters', '筛选', 'フィルター', '필터'],
  filtersHint: ['細部類型與 tag', 'Sub-types and tags', '细部类型与 tag', '詳細な種別とタグ', '세부 유형 및 태그'],
  search: ['搜尋關鍵字,空白分隔 = 都要符合', 'Search, space = all words must match', '搜索关键字,空白分隔 = 都要符合', 'キーワード検索(スペース区切り = すべてに一致)', '키워드 검색(공백 구분 = 모두 일치)'],
  window: ['範圍', 'Range', '范围', '範囲', '범위'],
  w5: ['±5 秒', '±5 s', '±5 秒', '±5 秒', '±5초'],
  w30: ['±30 秒', '±30 s', '±30 秒', '±30 秒', '±30초'],
  w120: ['±2 分', '±2 min', '±2 分', '±2 分', '±2분'],
  wAll: ['整場', 'All', '整场', '全体', '전체'],
  wStep: ['這一步', 'This step', '这一步', 'このステップ', '이 단계'],
  tagPick: ['只看某個 tag…', 'Only a tag…', '只看某个 tag…', '特定のタグのみ…', '특정 태그만…'],
  onlyTag: ['只看這個 tag', 'Only this tag', '只看这个 tag', 'このタグのみ表示', '이 태그만 보기'],
  hideTag: ['隱藏這個 tag', 'Hide this tag', '隐藏这个 tag', 'このタグを非表示', '이 태그 숨기기'],
  onlySub: ['只看這個類型', 'Only this type', '只看这个类型', 'この種別のみ表示', '이 유형만 보기'],
  hidden: ['隱藏', 'Hidden', '隐藏', '非表示', '숨김'],
  only: ['只看', 'Only', '只看', 'のみ表示', '만 보기'],
  remove: ['移除這個過濾', 'Remove this filter', '移除这个过滤', 'このフィルターを解除', '이 필터 제거'],
  clearAll: ['清除全部', 'Clear all', '清除全部', 'すべてクリア', '모두 지우기'],
  count: ['共 {n} 筆', '{n} items', '共 {n} 笔', '全 {n} 件', '총 {n}건'],
  empty: ['這個範圍沒有符合過濾條件的事件。', 'Nothing matches the filters in this range.', '这个范围没有符合过滤条件的事件。', 'この範囲にフィルター条件に一致するイベントはありません。', '이 범위에는 필터 조건에 맞는 이벤트가 없습니다.'],
  follow: ['跟著播放頭', 'Follow playhead', '跟着播放头', '再生位置に追従', '재생 위치 따라가기'],
  seek: ['跳到這一刻', 'Jump to this moment', '跳到这一刻', 'この時点へ移動', '이 시점으로 이동'],
} as const;
type K = keyof typeof T;
const tx = (k: K, lang: RLang, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce<string>((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), pick5(T[k], lang));
const subText = (sub: string, lang: RLang) => ((`s_${sub}` in T) ? tx(`s_${sub}` as K, lang) : sub);
const kindText = (k: FeedKind, lang: RLang) => tx(`k_${k}` as K, lang);

const SUB_ORDER: Record<FeedKind, string[]> = {
  step: ['agent', 'vision', 'reflex', 'operator'],
  ai: ['vlm', 'agent', 'subagent'],
  memory: ['reflex', 'known', 'learned', 'new', 'followed', 'diverged', 'no_effect', 'plan', 'hint', 'route'],
  script: ['progress', 'goal'],
  log: ['E', 'W', 'I', 'D', 'V'],
  sound: ['game', 'fail', 'onset', 'stream'],
  operator: ['command', 'gesture'],
};
const RANGES: Array<{ k: K; ms: number; step?: true }> = [
  { k: 'w5', ms: 5000 },
  { k: 'w30', ms: 30_000 },
  { k: 'w120', ms: 120_000 },
  { k: 'wAll', ms: 0 },
  { k: 'wStep', ms: 0, step: true },
];
const MAX_ROWS = 1500;
const STORE = 'pa.feedFilter.v1';
const FOLLOW_STORE = 'pa.feedFollow';

function loadFilter(): FeedFilter {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return { ...DEFAULT_FILTER, ...JSON.parse(raw), step: null };
  } catch { /* 無痕模式 */ }
  return DEFAULT_FILTER;
}
const sameFilter = (a: FeedFilter, b: FeedFilter) => JSON.stringify({ ...a, step: a.step === null ? null : -1 }) === JSON.stringify({ ...b, step: b.step === null ? null : -1 });

export function MomentFeed({ tl, steps, events, cursor, onSeek, lang }: {
  tl: Timeline;
  steps: Array<Record<string, unknown> & { index: number }>;
  events: FeedEvent[];
  cursor: number | null;
  onSeek: (t: number) => void;
  lang: RLang;
}) {
  const [f, setF] = useState<FeedFilter>(loadFilter);
  const [follow, setFollow] = useState(() => {
    try { return localStorage.getItem(FOLLOW_STORE) !== '0'; } catch { return true; }
  });
  const [open, setOpen] = useState<string | null>(null);
  const [typesOpen, setTypesOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ ...f, step: null })); } catch { /* 無痕模式 */ }
  }, [f]);
  useEffect(() => {
    try { localStorage.setItem(FOLLOW_STORE, follow ? '1' : '0'); } catch { /* 無痕模式 */ }
  }, [follow]);

  const step = cursor === null ? null : stepAt(tl, cursor);
  const stepRec = step ? steps.find((s) => s.index === step.index) : undefined;
  const eff: FeedFilter = f.step !== null ? { ...f, step: step?.index ?? null } : f;
  // 時間窗 / 數量:播放頭每 2 秒區間才重算(播放中不必每 0.1 秒重排上千筆)。
  const bucket = cursor === null ? null : Math.floor(cursor / 2000) * 2000 + 1000;
  const filtered = useMemo(() => applyFilter(events, eff, bucket), [events, eff.kinds, eff.subs, eff.tags, eff.excludeTags, eff.query, eff.windowMs, eff.step, bucket]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => feedCounts(events, bucket, f.windowMs), [events, bucket, f.windowMs]);
  // 這場有出現過的類別才顯示(播放頭移動時按鈕不會一下有一下沒有)。
  const present = useMemo(() => new Set(events.map((e) => e.kind)), [events]);
  const shown = useMemo(() => {
    if (filtered.length <= MAX_ROWS) return filtered;
    const i = bucket === null ? filtered.length - 1 : Math.max(0, lastAtOrBefore(filtered, bucket, (e) => e.t));
    const from = Math.max(0, Math.min(filtered.length - MAX_ROWS, i - MAX_ROWS / 2));
    return filtered.slice(from, from + MAX_ROWS);
  }, [filtered, bucket]);

  // 最接近播放頭的那一筆:高亮 + 捲到中間(直接改 DOM,不重畫清單)。
  const nearest = useMemo(() => {
    if (cursor === null || !shown.length) return -1;
    const i = lastAtOrBefore(shown, cursor, (e) => e.t);
    return Math.max(0, i);
  }, [shown, cursor]);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.querySelectorAll('.mfeed__row.is-now').forEach((n) => n.classList.remove('is-now'));
    if (nearest < 0) return;
    const el = box.querySelector<HTMLElement>(`[data-i="${nearest}"]`);
    if (!el) return;
    el.classList.add('is-now');
    if (follow) box.scrollTo({ top: Math.max(0, el.offsetTop - box.clientHeight / 2) });
  }, [nearest, follow, shown]);

  const toggleKind = (k: FeedKind) => setF((p) => ({ ...p, kinds: p.kinds.includes(k) ? p.kinds.filter((x) => x !== k) : [...p.kinds, k] }));
  const toggleSub = (k: FeedKind, sub: string) => setF((p) => {
    const all = SUB_ORDER[k];
    const cur = p.subs[k]?.length ? p.subs[k]! : all;
    const next = cur.includes(sub) ? cur.filter((x) => x !== sub) : [...cur, sub];
    const subs = { ...p.subs };
    if (next.length === 0 || next.length === all.length) delete subs[k];
    else subs[k] = next;
    return { ...p, subs };
  });
  const onlySub = (k: FeedKind, sub: string) => setF((p) => ({ ...p, kinds: p.kinds.includes(k) ? p.kinds : [...p.kinds, k], subs: { ...p.subs, [k]: [sub] } }));
  const onlyTag = (tag: string) => setF((p) => ({ ...p, tags: p.tags.includes(tag) ? p.tags : [...p.tags, tag] }));
  const hideTag = (tag: string) => setF((p) => ({ ...p, excludeTags: p.excludeTags.includes(tag) ? p.excludeTags : [...p.excludeTags, tag] }));
  const isFiltered = !sameFilter(f, DEFAULT_FILTER);
  const advCount = Object.keys(f.subs).length + f.tags.length + f.excludeTags.length;
  const rangeOn = (r: (typeof RANGES)[number]) => (r.step ? f.step !== null : f.step === null && f.windowMs === r.ms);

  const rows = useMemo(() => shown.map((e, i) => (
    <FeedRow
      key={e.id}
      i={i}
      e={e}
      lang={lang}
      origin={tl.origin}
      open={open === e.id}
      onOpen={() => setOpen((o) => (o === e.id ? null : e.id))}
      onSeek={onSeek}
      onOnlySub={onlySub}
      onOnlyTag={onlyTag}
      onHideTag={hideTag}
    />
  )), [shown, lang, tl.origin, open, onSeek]); // eslint-disable-line react-hooks/exhaustive-deps

  // 這一刻的摘要。
  const by = stepRec ? String(stepRec.decidedBy ?? 'agent') : 'agent';
  const byKey = step?.decidedBy ?? by;
  const memChips = memoryChips(stepRec?.memory as StepMemory | undefined, lang);
  const plan = stepRec?.plan as { scriptStep?: number; scriptTotal?: number; goal?: string } | undefined;
  const calls = cursor === null ? [] : tracesAt(tl, cursor);
  const db = cursor === null ? null : levelAt(tl, cursor);
  const quiet = db === null || db <= SILENT_DB;

  return (
    <div className="mfeed">
      {/* 即時訊息摘要(一行):時間 · 誰決定 · 步驟 · 動作 · 腳本 / 記憶 / AI / 聲音 icon(滑過看說明)· AI 判斷(太長省略,滑過看全文) */}
      {cursor !== null && (() => {
        const hue = DECIDER_ICON[byKey] ? byKey : 'agent';
        const sound = db === null ? tx('noRec', lang) : db <= SILENT_DB ? tx('silent', lang) : `${Math.round(db)} dB`;
        return (
          <div className="mfeed__now" aria-live="polite">
            <span className="mfeed__clock" data-tip={step ? tx('rel', lang, { n: step.index, s: ((cursor - step.t) / 1000).toFixed(2) }) : tx('beforeFirst', lang)}>
              {fmtClock(cursor - tl.origin)}
            </span>
            {!step ? (
              <span className="mfeed__muted">{tx('beforeFirst', lang)}</span>
            ) : (
              <>
                <span className={`mfeed__tile hue-${hue}`} data-tip={subText(byKey, lang)} aria-label={subText(byKey, lang)}>
                  <InfoIcon name={DECIDER_ICON[byKey] ?? 'compass'} size={14} />
                </span>
                <b className="mfeed__now-step">#{step.index} {step.screen ?? ''}</b>
                {(step.action || step.target) && (
                  <span className="mfeed__now-act">{step.action ?? ''}{step.target ? `「${step.target}」` : ''}</span>
                )}
                {typeof plan?.scriptStep === 'number' && typeof plan.scriptTotal === 'number' && (
                  <span
                    className="mfeed__mini hue-script"
                    data-tip={`${tx('k_script', lang)} ${plan.scriptStep}/${plan.scriptTotal}${plan.goal ? ` · ${plan.goal}` : ''}`}
                  >
                    <InfoIcon name="script" size={13} />{plan.scriptStep}/{plan.scriptTotal}
                  </span>
                )}
                {memChips.map((c, k) => (
                  <span
                    key={k}
                    className={`mfeed__mini ${c.tone === 'warn' ? 'hue-warn' : c.tone === 'new' ? 'hue-vision' : 'hue-memory'}`}
                    data-tip={`${c.text}${c.tip ? `\n${c.tip}` : ''}`}
                    aria-label={c.text}
                  >
                    <InfoIcon name={c.icon} size={13} />
                  </span>
                ))}
                {calls.map((c) => (
                  <span
                    key={`${c.seat}-${c.start}`}
                    className={`mfeed__mini ${c.ok ? (c.seat === 'agent' ? 'hue-agent' : 'hue-vision') : 'hue-warn'}`}
                    data-tip={`${subText(c.seat, lang)}${c.modelId ? ` · ${c.modelId}` : ''}`}
                    aria-label={subText(c.seat, lang)}
                  >
                    <InfoIcon name={SEAT_ICON[c.seat] ?? 'sparkle'} size={13} />
                  </span>
                ))}
                <span className="mfeed__mini" data-tip={`${tx('k_sound', lang)} · ${sound}`}>
                  <InfoIcon name={quiet ? 'mute' : 'volume'} size={13} />{db !== null && db > SILENT_DB ? `${Math.round(db)}` : ''}
                </span>
                {step.thinking && (
                  <span className="mfeed__now-think" data-tip={step.thinking}>{step.thinking}</span>
                )}
              </>
            )}
          </div>
        );
      })()}

      <div className="mfeed__filters">
        {/* 一行:類別(只有 icon,滑過看名稱與筆數)· 關鍵字 · 範圍 · 篩選 */}
        <div className="mfeed__bar">
          <div className="mfeed__kinds" role="group" aria-label={tx('kinds', lang)}>
            {FEED_KINDS.filter((k) => present.has(k) || !f.kinds.includes(k)).map((k) => {
              const on = f.kinds.includes(k);
              const label = tx('kindTip', lang, { k: kindText(k, lang), n: (counts.kinds[k] ?? 0).toLocaleString() });
              return (
                <button
                  key={k}
                  type="button"
                  className={`mfeed__kind${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  aria-label={label}
                  data-tip={`${label}${on ? '' : ` · ${tx('kindOff', lang)}`}`}
                  onClick={() => toggleKind(k)}
                >
                  <InfoIcon name={KIND_ICON[k]} size={15} />
                </button>
              );
            })}
          </div>
          <label className="mfeed__search">
            <InfoIcon name="search" size={14} />
            <input
              type="search"
              value={f.query}
              placeholder={tx('search', lang)}
              aria-label={tx('search', lang)}
              onChange={(e) => setF((p) => ({ ...p, query: e.target.value }))}
            />
          </label>
          <div className="mfeed__seg" role="radiogroup" aria-label={tx('window', lang)}>
            {RANGES.map((r) => (
              <button
                key={r.k}
                type="button"
                role="radio"
                aria-checked={rangeOn(r)}
                className={rangeOn(r) ? 'is-on' : ''}
                onClick={() => setF((p) => (r.step ? { ...p, step: -1, windowMs: 0 } : { ...p, step: null, windowMs: r.ms }))}
              >
                {tx(r.k, lang)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`mfeed__more${typesOpen ? ' is-open' : ''}${advCount ? ' is-active' : ''}`}
            aria-expanded={typesOpen}
            title={tx('filtersHint', lang)}
            onClick={() => setTypesOpen((v) => !v)}
          >
            <InfoIcon name="filter" size={14} />
            {tx('filters', lang)}
            {advCount > 0 && <small>+{advCount}</small>}
            <InfoIcon name={typesOpen ? 'chevUp' : 'chevDown'} size={12} />
          </button>
        </div>
        {typesOpen && (
          <div className="mfeed__types">
            {FEED_KINDS.filter((k) => f.kinds.includes(k) && present.has(k)).map((k) => (
              <div key={k} className="mfeed__type-row">
                <span className="mfeed__type-k"><InfoIcon name={KIND_ICON[k]} size={13} />{kindText(k, lang)}</span>
                {SUB_ORDER[k].filter((s) => counts.subs[`${k}:${s}`] || f.subs[k]?.includes(s)).map((s) => {
                  const on = !f.subs[k]?.length || f.subs[k]!.includes(s);
                  return (
                    <label key={s} className={`mfeed__sub hue-${eventHue(k, s)}${on ? ' is-on' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggleSub(k, s)} />
                      <InfoIcon name={eventIcon(k, s)} size={12} />
                      {subText(s, lang)} <small>{counts.subs[`${k}:${s}`] ?? 0}</small>
                    </label>
                  );
                })}
                {k === 'log' && counts.tags.length > 0 && (
                  <select
                    className="mfeed__tagpick"
                    value=""
                    aria-label={tx('tagPick', lang)}
                    onChange={(e) => { if (e.target.value) onlyTag(e.target.value); }}
                  >
                    <option value="">{tx('tagPick', lang)}</option>
                    {counts.tags.slice(0, 80).map(([tag, n]) => <option key={tag} value={tag}>{tag} ({n})</option>)}
                  </select>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mfeed__active">
          {Object.entries(f.subs).map(([k, list]) => (list?.length ? (
            <button key={k} type="button" className="mfeed__pill" title={tx('remove', lang)} onClick={() => setF((p) => { const subs = { ...p.subs }; delete subs[k as FeedKind]; return { ...p, subs }; })}>
              <InfoIcon name={KIND_ICON[k as FeedKind]} size={12} />
              {kindText(k as FeedKind, lang)}:{list.map((s) => subText(s, lang)).join('、')}
              <InfoIcon name="x" size={11} />
            </button>
          ) : null))}
          {f.tags.map((tag) => (
            <button key={`t-${tag}`} type="button" className="mfeed__pill" title={tx('remove', lang)} onClick={() => setF((p) => ({ ...p, tags: p.tags.filter((x) => x !== tag) }))}>
              {tx('only', lang)} {tag}<InfoIcon name="x" size={11} />
            </button>
          ))}
          {f.excludeTags.map((tag) => (
            <button key={`x-${tag}`} type="button" className="mfeed__pill is-ex" title={tx('remove', lang)} onClick={() => setF((p) => ({ ...p, excludeTags: p.excludeTags.filter((x) => x !== tag) }))}>
              {tx('hidden', lang)} {tag}<InfoIcon name="x" size={11} />
            </button>
          ))}
          {isFiltered && <button type="button" className="mfeed__clear" onClick={() => setF(DEFAULT_FILTER)}>{tx('clearAll', lang)}</button>}
          <span className="mfeed__spacer" />
          <span className="mfeed__count">{tx('count', lang, { n: filtered.length.toLocaleString() })}</span>
          <label className="mfeed__switch">
            <input type="checkbox" role="switch" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            <span className="mfeed__switch-ui" aria-hidden="true" />
            <span>{tx('follow', lang)}</span>
          </label>
        </div>
      </div>

      <div ref={boxRef} className="mfeed__list" role="log" aria-live="off" tabIndex={0}>
        {shown.length === 0 ? <p className="mfeed__muted">{tx('empty', lang)}</p> : rows}
      </div>
    </div>
  );
}

function FeedRow({ i, e, lang, origin, open, onOpen, onSeek, onOnlySub, onOnlyTag, onHideTag }: {
  i: number;
  e: FeedEvent;
  lang: RLang;
  origin: number;
  open: boolean;
  onOpen: () => void;
  onSeek: (t: number) => void;
  onOnlySub: (k: FeedKind, sub: string) => void;
  onOnlyTag: (tag: string) => void;
  onHideTag: (tag: string) => void;
}) {
  const hue = eventHue(e.kind, e.sub);
  return (
    <div data-i={i} className={`mfeed__row is-${e.kind} hue-${hue}${e.tone ? ` tone-${e.tone}` : ''}`}>
      <button type="button" className="mfeed__t" title={tx('seek', lang)} onClick={() => onSeek(e.t)}>{fmtClock(e.t - origin)}</button>
      <span className="mfeed__ico"><InfoIcon name={eventIcon(e.kind, e.sub)} size={13} /></span>
      <button type="button" className="mfeed__badge" title={tx('onlySub', lang)} onClick={() => onOnlySub(e.kind, e.sub)}>
        {e.kind === 'log' ? e.sub : subText(e.sub, lang)}
      </button>
      {e.tag && e.kind === 'log' && (
        <span className="mfeed__tag">
          <button type="button" title={tx('onlyTag', lang)} onClick={() => onOnlyTag(e.tag!)}>{e.tag}</button>
          <button type="button" className="mfeed__tag-x" title={tx('hideTag', lang)} aria-label={`${tx('hideTag', lang)} ${e.tag}`} onClick={() => onHideTag(e.tag!)}>
            <InfoIcon name="x" size={10} />
          </button>
        </span>
      )}
      {e.detail ? (
        <button type="button" className="mfeed__title mfeed__title--btn" aria-expanded={open} onClick={onOpen}>{e.title}</button>
      ) : (
        <span className="mfeed__title">{e.title}</span>
      )}
      {open && e.detail && <pre className="mfeed__detail">{e.detail}</pre>}
    </div>
  );
}
