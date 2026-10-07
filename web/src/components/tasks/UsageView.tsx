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
  costNote: ['費用 = Token × 這次測試各模型的單價(估算,不含真機時數)。', 'Cost = tokens × each model\'s price for this run (estimate; device minutes not included).', '费用 = Token × 这次测试各模型的单价(估算,不含真机时数)。', '費用 = トークン × 今回の各モデル単価(推定、実機時間は含みません)。', '비용 = 토큰 × 이번 테스트 각 모델 단가(추정, 실기기 시간 제외).'],
  vlm: ['視覺', 'Vision', '视觉', 'ビジョン', '비전'],
  agentSeat: ['決策', 'Decision', '决策', '判断', '결정'],
  subagent: ['輔助', 'Helper', '辅助', '補助', '보조'],
} as const satisfies Record<string, L5>;
const LOC_IDX: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };
const tx = (k: keyof typeof T, loc: string): string => (T[k] as L5)[LOC_IDX[loc] ?? 1] ?? T[k][1];

const SEATS: AgentSeat[] = ['vlm', 'agent', 'subagent'];
const SEAT_LABEL: Record<AgentSeat, keyof typeof T> = { vlm: 'vlm', agent: 'agentSeat', subagent: 'subagent' };

export interface SeatUsage { seat: AgentSeat; modelId?: string; calls: number; failed: number; input: number; output: number; cost?: number }

/** trace 精簡紀錄 → 每個 Agent 的用量(費用依該次測試的各模型單價)。 */
export function summarizeUsage(traces: TraceLog[], seats: MetaSeat[] = []): SeatUsage[] {
  return SEATS.map((seat) => {
    const list = traces.filter((t) => (t.seat ?? 'vlm') === seat);
    const input = list.reduce((s, t) => s + (t.tokens?.input ?? 0), 0);
    const output = list.reduce((s, t) => s + (t.tokens?.output ?? 0), 0);
    const price = seats.find((s) => s.seat === seat);
    const modelId = price?.modelId ?? list.find((t) => t.modelId)?.modelId;
    return {
      seat,
      ...(modelId ? { modelId } : {}),
      calls: list.length,
      failed: list.filter((t) => t.ok === false).length,
      input,
      output,
      ...(price ? { cost: (input * price.inputPerM + output * price.outputPerM) / 1_000_000 } : {}),
    };
  });
}

const n = (v: number) => v.toLocaleString();
const usd = (v: number | undefined) => (v === undefined ? '—' : v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** 用量分頁:每個 Agent 的 Token 用量與估算費用 + 每一步的用量。 */
export function UsageView({ traces, seats, loc }: { traces: TraceLog[] | null; seats: MetaSeat[]; loc: string }) {
  const rows = useMemo(() => summarizeUsage(traces ?? [], seats), [traces, seats]);
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
  const total = rows.reduce((s, r) => ({ calls: s.calls + r.calls, failed: s.failed + r.failed, input: s.input + r.input, output: s.output + r.output, cost: r.cost === undefined || s.cost === undefined ? undefined : s.cost + r.cost }), { calls: 0, failed: 0, input: 0, output: 0, cost: 0 as number | undefined });
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
