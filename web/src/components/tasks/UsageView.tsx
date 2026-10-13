import { useMemo } from 'react';
import type { MetaSeat } from '../../api/useJobStream.ts';
import { modelLabel } from '../modelProvider.ts';
import type { AgentSeat, TraceLog } from './AgentLogView.tsx';

type L5 = readonly [string, string, string, string, string];
const T = {
  agent: ['Agent', 'Agent', 'Agent', 'Agent', 'Agent'],
  model: ['模型', 'Model', '模型', 'モデル', '모델'],
  calls: ['呼叫次數', 'Calls', '调用次数', '呼び出し', '호출'],
  failed: ['失敗', 'Failed', '失败', '失敗', '실패'],
  input: ['輸入 Token', 'Input tokens', '输入 Token', '入力トークン', '입력 토큰'],
  output: ['輸出 Token', 'Output tokens', '输出 Token', '出力トークン', '출력 토큰'],
  avg: ['平均每次', 'Avg / call', '平均每次', '平均 / 回', '평균 / 회'],
  cost: ['估算費用', 'Est. cost', '估算费用', '推定費用', '예상 비용'],
  total: ['合計', 'Total', '合计', '合計', '합계'],
  perStep: ['每一步的用量(最新在上)', 'Usage per step (newest first)', '每一步的用量(最新在上)', 'ステップごとの使用量(新しい順)', '단계별 사용량(최신순)'],
  step: ['步驟', 'Step', '步骤', 'ステップ', '단계'],
  empty: ['還沒有用量紀錄。', 'No usage recorded yet.', '还没有用量记录。', '使用量の記録はまだありません。', '아직 사용량 기록이 없습니다.'],
  loading: ['載入中…', 'Loading…', '加载中…', '読み込み中…', '불러오는 중…'],
  cache: ['快取 Token', 'Cache tokens', '缓存 Token', 'キャッシュトークン', '캐시 토큰'],
  cacheSplit: ['寫入 {w} / 讀取 {r}', 'write {w} / read {r}', '写入 {w} / 读取 {r}', '書き込み {w} / 読み取り {r}', '쓰기 {w} / 읽기 {r}'],
  costNote: [
    '費用 = 每次呼叫的實際模型單價 × Token(輸入、輸出、快取寫入 1.25 倍、快取讀取 0.1 倍),是估算,不含真機時數。2026-10 以前的紀錄沒有快取 Token,費用會偏低。',
    'Cost = each call\'s actual model price × tokens (input, output, cache write at 1.25×, cache read at 0.1×). Estimate; device minutes not included. Runs before 2026-10 did not record cache tokens, so their cost is understated.',
    '费用 = 每次调用的实际模型单价 × Token(输入、输出、缓存写入 1.25 倍、缓存读取 0.1 倍),是估算,不含真机时数。2026-10 以前的记录没有缓存 Token,费用会偏低。',
    '費用 = 各呼び出しの実モデル単価 × トークン(入力・出力・キャッシュ書き込み 1.25 倍・読み取り 0.1 倍)。推定値で、実機時間は含みません。2026-10 以前の記録にはキャッシュトークンがなく、費用は低めです。',
    '비용 = 호출별 실제 모델 단가 × 토큰(입력, 출력, 캐시 쓰기 1.25배, 캐시 읽기 0.1배). 추정치이며 실기기 시간은 제외됩니다. 2026-10 이전 기록에는 캐시 토큰이 없어 비용이 낮게 나옵니다.',
  ],
  vlm: ['視覺', 'Vision', '视觉', 'ビジョン', '비전'],
  agentSeat: ['決策', 'Decision', '决策', '判断', '결정'],
  subagent: ['輔助', 'Helper', '辅助', '補助', '보조'],
} as const satisfies Record<string, L5>;
const LOC_IDX: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };
const tx = (k: keyof typeof T, loc: string): string => (T[k] as L5)[LOC_IDX[loc] ?? 1] ?? T[k][1];

const SEATS: AgentSeat[] = ['vlm', 'agent', 'subagent'];
const SEAT_LABEL: Record<AgentSeat, keyof typeof T> = { vlm: 'vlm', agent: 'agentSeat', subagent: 'subagent' };

export interface SeatUsage {
  seat: AgentSeat;
  modelId?: string;
  calls: number;
  failed: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
}

/** 每百萬 token 單價(含快取);快取單價缺省時用 Bedrock 的倍率(寫 1.25×、讀 0.1× input)。 */
export type PriceMap = Record<string, { inputPerM: number; outputPerM: number; cacheWritePerM?: number; cacheReadPerM?: number }>;

/** 一筆紀錄的花費:依該筆實際模型的目前單價;查不到用 seat 的單價(舊行為)。 */
export function traceCost(t: TraceLog, seatPrice: MetaSeat | undefined, prices: PriceMap = {}): number | undefined {
  const p: PriceMap[string] | undefined = (t.modelId ? prices[t.modelId] : undefined)
    ?? (seatPrice ? prices[seatPrice.modelId] ?? { inputPerM: seatPrice.inputPerM, outputPerM: seatPrice.outputPerM } : undefined);
  if (!p) return undefined;
  const tk = t.tokens ?? {};
  const cw = p.cacheWritePerM ?? p.inputPerM * 1.25;
  const cr = p.cacheReadPerM ?? p.inputPerM * 0.1;
  return ((tk.input ?? 0) * p.inputPerM + (tk.output ?? 0) * p.outputPerM + (tk.cacheWrite ?? 0) * cw + (tk.cacheRead ?? 0) * cr) / 1_000_000;
}

/** trace 精簡紀錄 → 每個 Agent 的用量(費用依每筆的實際模型單價,含快取 token)。 */
export function summarizeUsage(traces: TraceLog[], seats: MetaSeat[] = [], prices: PriceMap = {}): SeatUsage[] {
  return SEATS.map((seat) => {
    const list = traces.filter((t) => (t.seat ?? 'vlm') === seat);
    const sum = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => list.reduce((s, t) => s + (t.tokens?.[k] ?? 0), 0);
    const seatPrice = seats.find((s) => s.seat === seat);
    const modelId = seatPrice?.modelId ?? list.find((t) => t.modelId)?.modelId;
    let cost: number | undefined = 0;
    for (const t of list) {
      const c = traceCost(t, seatPrice, prices);
      if (c === undefined) { cost = undefined; break; }
      cost += c;
    }
    return {
      seat,
      ...(modelId ? { modelId } : {}),
      calls: list.length,
      failed: list.filter((t) => t.ok === false).length,
      input: sum('input'),
      output: sum('output'),
      cacheRead: sum('cacheRead'),
      cacheWrite: sum('cacheWrite'),
      ...(cost !== undefined ? { cost } : {}),
    };
  });
}

const n = (v: number) => v.toLocaleString();
const usd = (v: number | undefined) => (v === undefined ? '—' : v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** 用量分頁:每個 Agent 的 Token 用量與估算費用 + 每一步的用量。 */
export function UsageView({ traces, seats, prices, loc }: { traces: TraceLog[] | null; seats: MetaSeat[]; prices?: PriceMap; loc: string }) {
  const rows = useMemo(() => summarizeUsage(traces ?? [], seats, prices), [traces, seats, prices]);
  const perStep = useMemo(() => {
    const map = new Map<number, Partial<Record<AgentSeat, { input: number; output: number }>>>();
    for (const t of traces ?? []) {
      const seat = (t.seat ?? 'vlm') as AgentSeat;
      const cur = map.get(t.index) ?? {};
      const prev = cur[seat] ?? { input: 0, output: 0 };
      cur[seat] = { input: prev.input + (t.tokens?.input ?? 0), output: prev.output + (t.tokens?.output ?? 0) };
      map.set(t.index, cur);
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0]);
  }, [traces]);
  if (traces === null) return <p className="devlogs__muted">{tx('loading', loc)}</p>;
  if (traces.length === 0) return <p className="devlogs__muted">{tx('empty', loc)}</p>;
  const total = rows.reduce((s, r) => ({ calls: s.calls + r.calls, failed: s.failed + r.failed, input: s.input + r.input, output: s.output + r.output, cacheRead: s.cacheRead + r.cacheRead, cacheWrite: s.cacheWrite + r.cacheWrite, cost: r.cost === undefined || s.cost === undefined ? undefined : s.cost + r.cost }), { calls: 0, failed: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 as number | undefined });
  const cacheCell = (r: { cacheRead: number; cacheWrite: number }) => (
    <td className="is-num" title={tx('cacheSplit', loc).replace('{w}', n(r.cacheWrite)).replace('{r}', n(r.cacheRead))}>
      {r.cacheRead + r.cacheWrite > 0 ? n(r.cacheRead + r.cacheWrite) : '—'}
    </td>
  );
  const io = (u?: { input: number; output: number }) => (u ? `↑${n(u.input)} ↓${n(u.output)}` : '—');

  return (
    <div className="usage">
      <div className="devlogs__table-wrap usage__summary">
        <table className="devlogs__table">
          <thead>
            <tr>
              <th scope="col">{tx('agent', loc)}</th>
              <th scope="col">{tx('model', loc)}</th>
              <th scope="col" className="is-num">{tx('calls', loc)}</th>
              <th scope="col" className="is-num">{tx('input', loc)}</th>
              <th scope="col" className="is-num">{tx('output', loc)}</th>
              <th scope="col" className="is-num">{tx('cache', loc)}</th>
              <th scope="col" className="is-num">{tx('avg', loc)}</th>
              <th scope="col" className="is-num">{tx('cost', loc)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seat}>
                <th scope="row">{tx(SEAT_LABEL[r.seat], loc)}</th>
                <td title={r.modelId}>{r.modelId ? modelLabel(r.modelId).replace(/^[^·]+·\s*/, '') : '—'}</td>
                <td className="is-num">{n(r.calls)}{r.failed > 0 && <span className="usage__fail"> ({tx('failed', loc)} {r.failed})</span>}</td>
                <td className="is-num">{n(r.input)}</td>
                <td className="is-num">{n(r.output)}</td>
                {cacheCell(r)}
                <td className="is-num">{r.calls ? `↑${n(Math.round(r.input / r.calls))} ↓${n(Math.round(r.output / r.calls))}` : '—'}</td>
                <td className="is-num">{usd(r.cost)}</td>
              </tr>
            ))}
            <tr className="usage__total">
              <th scope="row">{tx('total', loc)}</th>
              <td />
              <td className="is-num">{n(total.calls)}</td>
              <td className="is-num">{n(total.input)}</td>
              <td className="is-num">{n(total.output)}</td>
              {cacheCell(total)}
              <td />
              <td className="is-num">{usd(total.cost)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="devlogs__muted">{tx('costNote', loc)}</p>
      <div className="usage__step-title">{tx('perStep', loc)}</div>
      <div className="devlogs__table-wrap">
        <table className="devlogs__table">
          <thead>
            <tr>
              <th scope="col">{tx('step', loc)}</th>
              {SEATS.map((s) => <th key={s} scope="col" className="is-num">{tx(SEAT_LABEL[s], loc)}</th>)}
            </tr>
          </thead>
          <tbody>
            {perStep.map(([idx, u]) => (
              <tr key={idx}>
                <td>#{idx}</td>
                {SEATS.map((s) => <td key={s} className="is-num devlogs__t">{io(u[s])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
