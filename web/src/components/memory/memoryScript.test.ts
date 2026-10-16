import { describe, expect, test } from 'vitest';
import {
  edgeOpKey,
  exportFileName,
  findScriptPath,
  generateAppiumScript,
  opTrust,
  popupHandlers,
  selfOpKey,
  spinOpOf,
  type OpEdit,
  type ScriptEdge,
  type ScriptPage,
} from './memoryScript.ts';

const page = (id: string, name: string, extra: Partial<ScriptPage> = {}): ScriptPage => ({ id, name, pHash: 'f'.repeat(64), ...extra });
const edge = (from: string, to: string, target: string, hit = 3, miss = 0, extra: Partial<ScriptEdge> = {}): ScriptEdge => ({
  fromPageId: from,
  toPageId: to,
  trigger: { kind: 'tap', target },
  hitCount: hit,
  missCount: miss,
  op: { a: 'tap', x: 0.5, y: 0.8 },
  ...extra,
});

describe('opTrust (same rules as agent/reflex.mjs)', () => {
  // [hit, miss, manual, edit, expected] — 與 infra/test/reflex.test.ts 的 opTrust 案例一致。
  const cases: Array<[number, number, boolean, OpEdit | undefined, string]> = [
    [0, 0, false, undefined, 'learning'],
    [1, 0, false, undefined, 'learning'],
    [2, 0, false, undefined, 'auto'],
    [5, 1, false, undefined, 'learning'],
    [0, 3, false, { verified: true }, 'verified'],
    [9, 0, false, { disabled: true }, 'disabled'],
    [9, 0, false, { verified: true, disabled: true }, 'disabled'],
    [0, 0, true, { op: { a: 'tap', x: 0.1, y: 0.1 } }, 'verified'],
    [0, 0, true, undefined, 'learning'],
  ];
  test.each(cases)('hit=%i miss=%i manual=%s → %s', (hitCount, missCount, manual, edit, expected) => {
    expect(opTrust({ hitCount, missCount, manual }, edit)).toBe(expected);
  });
});

describe('findScriptPath', () => {
  const pages: Record<string, ScriptPage> = {
    home: page('home', '首頁'),
    lobby: page('lobby', '大廳'),
    shop: page('shop', '商店'),
    slot: page('slot', '老虎機'),
  };

  test('shortest path from root, skips purchase targets', () => {
    const edges = [
      edge('home', 'lobby', 'Play'),
      edge('lobby', 'slot', 'Lucky 777'),
      edge('home', 'slot', 'Buy $4.99'), // 付費,不能走
    ];
    const steps = findScriptPath(pages, edges, {}, 'slot', 'home');
    expect(steps?.map((s) => s.target)).toEqual(['Play', 'Lucky 777']);
    expect(steps?.[0]?.from.hashes).toEqual(['f'.repeat(64)]);
  });

  test('skips disabled ops and edges without positions; uses edited op', () => {
    const e1 = edge('home', 'lobby', 'Play');
    const e2 = edge('lobby', 'slot', 'Lucky 777');
    const direct = edge('home', 'slot', 'Quick');
    const noOp: ScriptEdge = { ...edge('home', 'shop', 'Shop'), op: undefined };
    const edits: Record<string, OpEdit> = {
      [edgeOpKey(direct)]: { disabled: true },
      [edgeOpKey(e2)]: { op: { a: 'tap', x: 0.2, y: 0.3 } },
    };
    const steps = findScriptPath(pages, [e1, e2, direct, noOp], edits, 'slot', 'home');
    expect(steps?.map((s) => s.target)).toEqual(['Play', 'Lucky 777']);
    expect(steps?.[1]?.op).toEqual({ a: 'tap', x: 0.2, y: 0.3 });
    expect(findScriptPath(pages, [e1, e2, direct, noOp], edits, 'shop', 'home')).toBeNull();
  });

  test('prefers trusted edge when paths are the same length', () => {
    const shaky = edge('home', 'lobby', 'Maybe', 9, 2);
    const sure = edge('home', 'lobby', 'Play', 1, 0);
    const steps = findScriptPath(pages, [shaky, sure], { [edgeOpKey(sure)]: { verified: true } }, 'lobby', 'home');
    expect(steps?.[0]?.target).toBe('Play');
    expect(steps?.[0]?.trust).toBe('verified');
  });

  test('target is the root → empty path', () => {
    expect(findScriptPath(pages, [], {}, 'home', 'home')).toEqual([]);
  });
});

describe('popupHandlers / spinOpOf', () => {
  test('only trusted, non-purchase popup exits', () => {
    const pages = { pop: page('pop', '每日獎勵彈窗'), home: page('home', '首頁') };
    const edges = [
      edge('pop', 'home', '關閉 X'),
      edge('pop', 'home', 'Buy USD 1.99'),
      edge('pop', 'home', 'Later', 1, 0),
      edge('home', 'pop', 'Gift'),
    ];
    const h = popupHandlers(pages, edges, {});
    expect(h.map((x) => x.target)).toEqual(['關閉 X']);
  });

  test('spin op skips auto/free spin and disabled', () => {
    const p = page('slot', '老虎機', {
      selfOps: [
        { kind: 'tap', target: 'Auto Spin', hitCount: 5, missCount: 0, op: { a: 'tap', x: 0.7, y: 0.9 } },
        { kind: 'tap', target: 'SPIN', hitCount: 5, missCount: 0, op: { a: 'tap', x: 0.9, y: 0.9 } },
      ],
    });
    expect(spinOpOf(p, {})?.target).toBe('SPIN');
    const off = { [selfOpKey('slot', p.selfOps![1]!)]: { disabled: true } };
    expect(spinOpOf(p, off)).toBeNull();
  });
});

describe('generateAppiumScript', () => {
  test('embeds the steps and is syntactically valid ESM', async () => {
    const pages = { home: page('home', '首頁'), slot: page('slot', '老虎機') };
    const steps = findScriptPath(pages, [edge('home', 'slot', 'Play')], {}, 'slot', 'home')!;
    const text = generateAppiumScript({
      appId: 'com.example.slots',
      appName: 'Slots',
      steps,
      target: { id: 'slot', name: '老虎機', hashes: ['f'.repeat(64)] },
      handlers: [],
      spin: { target: 'SPIN', op: { a: 'tap', x: 0.9, y: 0.9 } },
      generatedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(text).toContain('"target": "Play"');
    expect(text).toContain('首頁 → 老虎機');
    expect(text).toContain("from 'webdriverio'");
    expect(text).toContain('--spins');
    // 語法檢查:把 import 換掉、包成 async function 後交給 Function 解析(不執行)。
    const body = text
      .replace(/^#!.*\n/, '')
      .replace(/^import .*$/gm, '')
      .replace(/^const driver = await remote/m, 'const driver = await (async (x) => x)');
    expect(() => new Function(`return (async () => {\n${body}\n});`)).not.toThrow();
  });

  test('file name is safe', () => {
    expect(exportFileName('com.example/slots', '老虎機 主畫面!')).toBe('playagent-com_example_slots-老虎機_主畫面.mjs');
  });
});
