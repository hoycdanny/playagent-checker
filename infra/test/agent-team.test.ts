import { describe, expect, test } from 'vitest';
import { spendBySeat } from '../lambda/api/tasks.js';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const at = await import('../../agent/agentTeam.mjs');

class FakeConverse { constructor(public input: { modelId: string; system: Array<{ text: string }>; messages: Array<{ content: Array<{ text: string }> }>; inferenceConfig: Record<string, unknown> }) {} }

function setup(replies: Record<string, string | Error>, opts: { agentModel?: string; subagentModel?: string } = {}) {
  const calls: FakeConverse[] = [];
  const puts = new Map<string, string>();
  const bedrock = {
    send: async (cmd: FakeConverse) => {
      calls.push(cmd);
      const sys = cmd.input.system[0]!.text;
      const key = sys.includes('決策 Agent') ? 'plan' : sys.includes('核對「測試完成」') ? 'done' : sys.includes('進度摘要') ? 'summary' : 'review';
      const r = replies[key];
      if (r instanceof Error) throw r;
      return { output: { message: { content: [{ text: r ?? '' }] } }, usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
  const team = at.createAgentTeam({
    bedrock,
    ConverseCommand: FakeConverse,
    agentModel: opts.agentModel ?? 'us.amazon.nova-lite-v1:0',
    subagentModel: opts.subagentModel ?? 'us.amazon.nova-micro-v1:0',
    task: '1. 進入大廳\n2. 進入第一關\n3. 打到第 3 波',
    controlsPrompt: '可用動作只有:tap / move',
    put: async (k: string, b: string) => { puts.set(k, b); },
    prefix: 'p',
    timeoutMs: 1000,
  });
  return { team, calls, puts };
}

describe('agentTeam helpers', () => {
  test('parseJsonObject tolerates fences, prose and braces inside strings', () => {
    expect(at.parseJsonObject('好的\n```json\n{"goal":"點 {OK}","n":1}\n```')).toEqual({ goal: '點 {OK}', n: 1 });
    expect(at.parseJsonObject('no json')).toBeNull();
  });
  test('scriptSteps / normalizeFacts', () => {
    expect(at.scriptSteps('1. a\n2. b\n   b2\n3) c')).toEqual(['a', 'b b2', 'c']);
    expect(at.scriptSteps('only one line')).toEqual(['only one line']);
    expect(at.normalizeFacts({ 'Coin Balance': '3,934,572,760', HP: 80, stage: 'Wave 3', '': 1 })).toEqual({ coin_balance: 3934572760, hp: 80, stage: 'Wave 3' });
  });
});

describe('decision agent (decideAction)', () => {
  const elements = [
    { id: 1, label: 'START', x: 500, y: 900, kind: 'button' },
    { id: 2, label: '關閉 ✕', x: 980, y: 60, kind: 'close' },
    { id: 3, label: '搖桿', x: 480, y: 1800, kind: 'joystick' },
  ];
  const dims = { cw: 1000, ch: 2000 };
  const base = { observation: { screen: '大廳', seen: '大廳,有開始按鈕' }, elements, suggestion: { action: 'tap', target: 'START' }, screenChanged: true, allowedActions: ['tap', 'swipe', 'back', 'wait', 'done', 'move'], dims };

  test('picks an element → coordinates come from the element list; trace + tokens recorded; prompt has elements/controls/operator', async () => {
    const { team, calls, puts } = setup({ plan: '{"action":"tap","element":2,"goal":"關掉公告","expect":"回到大廳","scriptStep":2,"strategy":"先處理彈窗"}' });
    const r = await team.decideAction({ ...base, index: 5, operator: ['先關公告'] });
    expect(r!.cmd).toEqual({ action: 'tap', target: '關閉 ✕', x: 980, y: 60 });
    expect(r!.decision).toMatchObject({ forStep: 5, goal: '關掉公告', expect: '回到大廳', scriptStep: 2 });
    const prompt = calls[0]!.input.messages[0]!.content[0]!.text;
    for (const s of ['[2] 關閉 ✕(close)', '可用動作只有:tap / move', '先關公告', 'tap → START']) expect(prompt).toContain(s);
    expect(JSON.parse(puts.get('p/traces/5-agent.json')!)).toMatchObject({ index: 5, seat: 'agent', ok: true });
    expect(team.tokens.agent).toEqual({ input: 100, output: 20 });
  });

  test('"vision", unknown element, or an action outside the allowed list → cmd null (use the vision suggestion)', async () => {
    for (const reply of ['{"action":"vision","goal":"照建議"}', '{"action":"tap","element":9}', '{"action":"pinch","element":1}']) {
      const { team } = setup({ plan: reply });
      const r = await team.decideAction({ ...base, index: 1 });
      expect(r).not.toBeNull();
      expect(r!.cmd).toBeNull();
    }
  });

  test('model failure or garbage → null; failure is logged', async () => {
    const bad = setup({ plan: new Error('ThrottlingException') });
    expect(await bad.team.decideAction({ ...base, index: 0 })).toBeNull();
    expect(JSON.parse(bad.puts.get('p/traces/0-agent.json')!).ok).toBe(false);
    const garbage = setup({ plan: '我不知道' });
    expect(await garbage.team.decideAction({ ...base, index: 0 })).toBeNull();
  });

  test('disabled when no model is configured', async () => {
    const { team, calls } = setup({}, { agentModel: '', subagentModel: '' });
    expect(team.enabled).toEqual({ agent: false, subagent: false });
    expect(await team.decideAction({ ...base, index: 0 })).toBeNull();
    expect(await team.review({ index: 1, observation: {} })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('helper agent', () => {
  test('review: effect + normalized facts merged over time + issues', async () => {
    const { team } = setup({ review: '{"effect":"no_effect","note":"畫面沒變","facts":{"Balance":"1,000,000","wave":2},"issues":["餘額從 39 億變 100 萬"]}' });
    const r = await team.review({ index: 3, prevAction: 'tap', prevPlan: { goal: '點 OK' }, observation: { screen: '彈窗', thinking: '...' }, screenChanged: false });
    expect(r).toMatchObject({ effect: 'no_effect', facts: { balance: 1000000, wave: 2 }, issues: ['餘額從 39 億變 100 萬'] });
    expect(team.facts).toEqual({ balance: 1000000, wave: 2 });
  });
  test('numbers changed → never "no effect" (job-muvgmxct: spins completed but judged no_effect)', async () => {
    expect(at.changedFacts({ balance: 1, loading_progress: 5 }, { balance: 2, loading_progress: 9 })).toEqual(['balance']);
    // 模型每次都說 no_effect(「旋轉動畫沒有啟動」),但視覺 Agent 回報的餘額每次都在變
    const { team } = setup({ review: '{"effect":"no_effect","note":"旋轉動畫沒有啟動"}' });
    const first = await team.review({ index: 1, observation: { obs: { balance: 1114910, bet: 1320 } } });
    expect(first!.effect).toBe('no_effect'); // 第一次沒有上一份數值可比
    const second = await team.review({ index: 2, observation: { obs: { balance: 1113990, bet: 1320 } } });
    expect(second!.effect).toBe('ok');
    expect(second!.note).toContain('balance');
    // 只有讀取進度在變 → 維持 no_effect
    const third = await team.review({ index: 3, observation: { obs: { balance: 1113990, bet: 1320, loading_progress: 50 } } });
    const fourth = await team.review({ index: 4, observation: { obs: { balance: 1113990, bet: 1320, loading_progress: 90 } } });
    expect(third!.effect).toBe('no_effect');
    expect(fourth!.effect).toBe('no_effect');
  });

  test('unknown effect value is normalized', async () => {
    const { team } = setup({ review: '{"effect":"great","facts":{}}' });
    expect((await team.review({ index: 1, observation: {} }))!.effect).toBe('unknown');
  });
  test('verifyDone', async () => {
    const no = setup({ done: '{"ok":false,"missing":"還沒打到第 3 波"}' });
    expect(await no.team.verifyDone({ index: 9, observation: { screen: '第 2 波' } })).toEqual({ ok: false, missing: '還沒打到第 3 波' });
    const unparsable = setup({ done: 'yes' });
    expect(await unparsable.team.verifyDone({ index: 9, observation: {} })).toBeNull();
  });
  test('summary runs every 10 steps only', async () => {
    const { team, calls } = setup({ summary: '已進入第一關,彈窗會反覆出現' });
    await team.maybeSummarize(3);
    expect(calls).toHaveLength(0);
    await team.maybeSummarize(10);
    expect(calls).toHaveLength(1);
  });
});

describe('decisionToCommand / normalizeElements', () => {
  const els = at.normalizeElements([
    { id: 1, label: 'SPIN', x: 1640, y: 880 },
    { id: '2', label: '寶物', x: '300', y: 400 },
    { label: '沒座標' },
    { id: 4, label: '越界', x: 99999, y: -5 },
    { id: 5, label: '搖桿', x: 500, y: 900, kind: 'joystick' },
  ], 2000, 1000);
  const dims = { cw: 2000, ch: 1000 };
  test('elements: coerce numbers, clamp into the screen, drop entries without coordinates', () => {
    expect(els.map((e: { id: number; x: number; y: number }) => [e.id, e.x, e.y])).toEqual([[1, 1640, 880], [2, 300, 400], [4, 2000, 0], [5, 500, 900]]);
  });
  test('maps each action type generically', () => {
    const d = (o: Record<string, unknown>) => at.decisionToCommand(o, els, dims);
    expect(d({ action: 'hold', element: 1, holdMs: 1500 })).toEqual({ action: 'hold', target: 'SPIN', x: 1640, y: 880, holdMs: 1500 });
    expect(d({ action: 'swipe', element: 2, toElement: 1, durationMs: 800 })).toMatchObject({ x: 300, y: 400, x2: 1640, y2: 880, durationMs: 800 });
    expect(d({ action: 'swipe', element: 2, dir: 'up' })).toMatchObject({ x2: 300, y2: 150 });
    expect(d({ action: 'move', dir: 'left', holdMs: 2000 })).toEqual({ action: 'move', dir: 'left', holdMs: 2000 });
    expect(d({ action: 'move', element: 5, dir: 'upleft' })).toMatchObject({ x: 500, y: 900, dir: 'upleft' });
    expect(d({ action: 'combo', element: 5, dir: 'right', tapElement: 1, taps: 2, holdMs: 1500 })).toMatchObject({ x: 500, y: 900, tx: 1640, ty: 880, taps: 2 });
    expect(d({ action: 'wait', duration: 99 })).toEqual({ action: 'wait', duration: 10 });
    expect(d({ action: 'type', text: '${TEST_USER}' })).toEqual({ action: 'type', text: '${TEST_USER}' });
    expect(d({ action: 'back' })).toEqual({ action: 'back' });
    expect(d({ action: 'move' })).toBeNull();
    expect(d({ action: 'swipe', element: 2 })).toBeNull();
    expect(d({ action: 'tap' })).toBeNull();
    expect(d({ action: 'teleport', element: 1 })).toBeNull();
  });
  test('VISION_ELEMENTS_NOTE asks for seen + elements', () => {
    expect(at.VISION_ELEMENTS_NOTE).toContain('"elements"');
    expect(at.VISION_ELEMENTS_NOTE).toContain('"seen"');
  });
});

describe('spendBySeat', () => {
  test('prices each agent with its own model; no per-seat data → undefined', () => {
    const v = spendBySeat(
      { tokensBySeat: { vlm: { input: 1_000_000, output: 0 }, agent: { input: 1_000_000, output: 0 }, subagent: { input: 0, output: 0 } } },
      (s) => ({ vlm: 'anthropic.claude-haiku-4-5-20251001-v1:0', agent: 'anthropic.claude-3-haiku-20240307-v1:0' } as Record<string, string>)[s],
    );
    expect(v).toBeCloseTo(1 + 0.25, 5);
    expect(spendBySeat({}, () => undefined)).toBeUndefined();
  });
});
