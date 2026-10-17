import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from '../../api/client.ts';

/** 對齊後端 report/types.ts MetricValue。 */
export interface LiveMetric {
  id: string;
  label: { zh: string; en: string };
  unit: string;
  group: string;
  source: 'objective' | 'ai_evaluation';
  value: number | null;
  status: 'ok' | 'not_collected';
  profile: string;
}
interface LiveMetricsResponse { metrics: LiveMetric[]; stepCount: number; final: boolean; at: string }

/** [繁中, English, 简中, 日本語, 한국어] */
type L5 = readonly [string, string, string, string, string];
const T = {
  pick: ['選擇要追蹤的指標', 'Choose metrics to track', '选择要追踪的指标', '追跡する指標を選択', '추적할 지표 선택'],
  done: ['完成', 'Done', '完成', '完了', '완료'],
  search: ['搜尋指標', 'Search metrics', '搜索指标', '指標を検索', '지표 검색'],
  noneSelected: ['還沒有勾選指標。按「選擇要追蹤的指標」,勾選後這裡會即時計算。', 'No metrics selected. Choose metrics to track and they are calculated here live.', '还没有勾选指标。按「选择要追踪的指标」,勾选后这里会实时计算。', '指標が選択されていません。「追跡する指標を選択」から選ぶと、ここでリアルタイムに計算します。', '선택된 지표가 없습니다. "추적할 지표 선택"에서 고르면 여기서 실시간으로 계산합니다.'],
  notCollected: ['尚未收集', 'Not collected yet', '尚未收集', '未収集', '아직 수집 안 됨'],
  aiEval: ['AI 評估', 'AI evaluated', 'AI 评估', 'AI 評価', 'AI 평가'],
  liveNote: ['依目前 {n} 步的資料計算 · 每 10 秒更新(與測試報告同一套指標)', 'Calculated from the first {n} steps · refreshes every 10 s (same metrics as the test report)', '依目前 {n} 步的数据计算 · 每 10 秒更新(与测试报告同一套指标)', '現在の {n} ステップのデータで計算 · 10 秒ごとに更新(テストレポートと同じ指標)', '현재 {n}단계 데이터로 계산 · 10초마다 갱신(테스트 보고서와 같은 지표)'],
  finalNote: ['測試已結束,以下為最終數據(共 {n} 步)', 'Test finished; final values ({n} steps)', '测试已结束,以下为最终数据(共 {n} 步)', 'テスト終了。最終値です({n} ステップ)', '테스트 종료, 최종 값입니다({n}단계)'],
  loading: ['計算中…', 'Calculating…', '计算中…', '計算中…', '계산 중…'],
  error: ['暫時無法計算指標', 'Could not calculate metrics', '暂时无法计算指标', '指標を計算できませんでした', '지표를 계산할 수 없습니다'],
  selected: ['已追蹤 {n} 項', '{n} tracked', '已追踪 {n} 项', '{n} 件を追跡中', '{n}개 추적 중'],
  clear: ['全部取消', 'Clear all', '全部取消', 'すべて解除', '모두 해제'],
  hint: ['勾選要追蹤的指標,測試中即時計算(與測試報告同一套指標)', 'Track the metrics you pick, calculated live during the test (same metrics as the test report)', '勾选要追踪的指标,测试中实时计算(与测试报告同一套指标)', '選んだ指標をテスト中にリアルタイムで計算(テストレポートと同じ指標)', '선택한 지표를 테스트 중 실시간 계산(테스트 보고서와 같은 지표)'],
} as const satisfies Record<string, L5>;
const LOC_IDX: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };
const tx = (k: keyof typeof T, loc: string): string => (T[k] as L5)[LOC_IDX[loc] ?? 1] ?? T[k][1];

/** 分頁說明(由分頁列的擁有者顯示;面板本身在載入中/空資料時會提早回傳,放不進去)。 */
export const analysisHint = (loc: string): string => tx('hint', loc);

const GROUP: Record<string, L5> = {
  summary: ['總覽', 'Summary', '总览', '概要', '요약'],
  genre: ['遊戲類型指標', 'Genre metrics', '游戏类型指标', 'ジャンル指標', '장르 지표'],
  economy: ['經濟', 'Economy', '经济', '経済', '경제'],
  progression: ['進度', 'Progression', '进度', '進行', '진행'],
  performance: ['效能', 'Performance', '性能', 'パフォーマンス', '성능'],
  stability: ['穩定性', 'Stability', '稳定性', '安定性', '안정성'],
  coverage: ['覆蓋率', 'Coverage', '覆盖率', 'カバレッジ', '커버리지'],
  ux: ['UX', 'UX', 'UX', 'UX', 'UX'],
  ai_reliability: ['AI 可靠度', 'AI reliability', 'AI 可靠度', 'AI 信頼性', 'AI 신뢰도'],
};
const GROUP_ORDER = ['summary', 'genre', 'economy', 'progression', 'performance', 'stability', 'coverage', 'ux', 'ai_reliability'];

const labelOf = (m: LiveMetric, loc: string) => (loc.startsWith('zh') ? m.label.zh : m.label.en);
const storageKey = (appId: string | undefined) => `pa.trackedMetrics.${appId || '_'}`;

export function fmtMetric(v: number, unit: string): string {
  const n = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
  const s = n.toLocaleString();
  switch (unit) {
    case '%': return `${s}%`;
    case 'pp': return `${s} pp`;
    case 'count': case '': return s;
    case '/h': return `${s}/h`;
    default: return `${s} ${unit}`;
  }
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 26}`).join(' ');
  return (
    <svg className="lana__spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * 分析分頁:使用者勾選要追蹤的指標(與測試報告同一套指標定義),測試中每 10 秒用目前的步驟即時計算。
 * 勾選記在瀏覽器(依應用),同一個應用下次測試沿用。
 */
export function LiveAnalysisView({ jobId, isLive, appId, loc }: { jobId: string; isLive: boolean; appId?: string; loc: string }) {
  const [data, setData] = useState<LiveMetricsResponse | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(storageKey(appId)) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }
    catch { return []; }
  });
  const [picking, setPicking] = useState(selected.length === 0);
  const [query, setQuery] = useState('');
  const history = useRef(new Map<string, number[]>());

  useEffect(() => {
    try { localStorage.setItem(storageKey(appId), JSON.stringify(selected)); } catch { /* ignore */ }
  }, [appId, selected]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    history.current = new Map();
    const load = async () => {
      try {
        const r = await apiGet<LiveMetricsResponse>(`/tasks/${encodeURIComponent(jobId)}/live-metrics`);
        if (stop) return;
        for (const m of r.metrics) {
          if (m.status !== 'ok' || m.value === null) continue;
          const h = history.current.get(m.id) ?? [];
          if (h[h.length - 1] !== m.value || h.length === 0) h.push(m.value);
          history.current.set(m.id, h.slice(-40));
        }
        setData(r);
        setError(false);
      } catch {
        if (!stop) setError(true);
      }
      if (!stop && isLive) timer = setTimeout(() => void load(), 10_000);
    };
    void load();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [jobId, isLive]);

  const byId = useMemo(() => new Map((data?.metrics ?? []).map((m) => [m.id, m])), [data]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, LiveMetric[]>();
    for (const m of data?.metrics ?? []) {
      if (q && !`${m.label.zh} ${m.label.en} ${m.id}`.toLowerCase().includes(q)) continue;
      const list = map.get(m.group) ?? [];
      list.push(m);
      map.set(m.group, list);
    }
    return [...map.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]));
  }, [data, query]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const tracked = selected.map((id) => byId.get(id)).filter((m): m is LiveMetric => !!m);

  if (!data && !error) return <p className="devlogs__muted">{tx('loading', loc)}</p>;
  if (!data) return <p className="devlogs__muted" role="alert">{tx('error', loc)}</p>;
  const groupLabel = (g: string) => (GROUP[g] ? GROUP[g][LOC_IDX[loc] ?? 1] : g);

  return (
    <div className="lana">
      <div className="devlogs__bar">
        <button type="button" className="devlogs__btn" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
          {picking ? tx('done', loc) : tx('pick', loc)}
        </button>
        <span className="devlogs__muted">{tx('selected', loc).replace('{n}', String(selected.length))}</span>
        <span className="devlogs__spacer" />
        <span className="devlogs__muted">{(data.final ? tx('finalNote', loc) : tx('liveNote', loc)).replace('{n}', String(data.stepCount))}</span>
      </div>

      {tracked.length === 0 ? (
        !picking && <p className="devlogs__muted">{tx('noneSelected', loc)}</p>
      ) : (
        <ul className="lana__cards">
          {tracked.map((m) => {
            const h = history.current.get(m.id) ?? [];
            const prev = h.length >= 2 ? h[h.length - 2]! : undefined;
            const delta = m.value !== null && prev !== undefined ? m.value - prev : undefined;
            return (
              <li key={m.id} className={`lana__card ${m.status === 'ok' ? '' : 'is-empty'}`}>
                <div className="lana__card-head">
                  <span className="lana__label">{labelOf(m, loc)}</span>
                  {m.source === 'ai_evaluation' && <span className="lana__tag">{tx('aiEval', loc)}</span>}
                </div>
                <div className="lana__value">
                  {m.status === 'ok' && m.value !== null ? fmtMetric(m.value, m.unit) : tx('notCollected', loc)}
                  {delta !== undefined && delta !== 0 && (
                    <span className={`lana__delta ${delta > 0 ? 'is-up' : 'is-down'}`}>{delta > 0 ? '▲' : '▼'} {fmtMetric(Math.abs(delta), m.unit)}</span>
                  )}
                </div>
                <Spark values={h} />
              </li>
            );
          })}
        </ul>
      )}

      {picking && (
        <fieldset className="lana__picker">
          <legend className="visually-hidden">{tx('pick', loc)}</legend>
          <div className="devlogs__bar">
            <input type="search" className="devlogs__search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tx('search', loc)} aria-label={tx('search', loc)} />
            {selected.length > 0 && <button type="button" className="devlogs__btn" onClick={() => setSelected([])}>{tx('clear', loc)}</button>}
          </div>
          {groups.map(([g, list]) => (
            <div key={g} className="lana__group">
              <div className="lana__group-title">{groupLabel(g)}</div>
              <div className="lana__options">
                {list.map((m) => (
                  <label key={m.id} className="lana__option">
                    <input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggle(m.id)} />
                    <span>{labelOf(m, loc)}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </fieldset>
      )}
    </div>
  );
}
