import { describe, expect, test } from 'vitest';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  addHint,
  applyEdit,
  parseRoute,
  deleteHint,
  HintNotFoundError,
  HintValidationError,
  isTransientScreenName,
  listHints,
  parseEditOp,
  readEdits,
  updateHint,
} from '../lambda/api/memoryHints.js';
import {
  CommandValidationError,
  listCommands,
  newCommandId,
  validateCommandBody,
  writeCommand,
} from '../lambda/api/operatorCommands.js';
import {
  applyEdits,
  createOperatorChannel,
  edgeKey,
  hintsPromptSection,
  loadAppMemory,
  operatorTurnNote,
  routesPromptSection,
  routeTurnNote,
  sameScreen,
  screenHintsFor,
} from '../../agent/operatorMemory.mjs';
import { compactStructure, emptyStructure, recordTransition, summarizeForAgent, upsertPage } from '../../agent/memoryGraph.mjs';
const runnerMod = { createOperatorChannel, loadAppMemory };

/** 最小 S3 假物件:Put(If-Match / If-None-Match + ETag)、Get、List。 */
function fakeS3(opts: { conflictOnce?: boolean } = {}) {
  const store = new Map<string, { body: string; etag: string }>();
  let n = 0;
  let conflictPending = !!opts.conflictOnce;
  const send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const i = cmd.input;
    switch (cmd.constructor.name) {
      case 'PutObjectCommand': {
        const key = i['Key'] as string;
        const cur = store.get(key);
        const fail = () => { throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }); };
        if (i['IfNoneMatch'] === '*' && cur) fail();
        if (i['IfMatch'] !== undefined && (!cur || cur.etag !== i['IfMatch'])) fail();
        if (conflictPending && (i['IfMatch'] !== undefined || i['IfNoneMatch'] !== undefined)) {
          // 模擬另一個人剛好先寫入:改掉 etag 讓這次寫入衝突,應自動重試成功。
          conflictPending = false;
          if (cur) cur.etag = `"x${++n}"`;
          else store.set(key, { body: JSON.stringify({ schemaVersion: 1, hints: [] }), etag: `"x${++n}"` });
          fail();
        }
        store.set(key, { body: String(i['Body']), etag: `"e${++n}"` });
        return {};
      }
      case 'GetObjectCommand': {
        const o = store.get(i['Key'] as string);
        if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => o.body }, ETag: o.etag };
      }
      case 'ListObjectsV2Command': {
        const p = i['Prefix'] as string;
        return { Contents: [...store.keys()].filter((k) => k.startsWith(p)).sort().map((Key) => ({ Key })) };
      }
    }
    throw new Error(`unsupported ${cmd.constructor.name}`);
  };
  return { s3: { send } as unknown as S3Client, store };
}

const PAGE = 'page_0123abcd';

describe('memory hints (hints.json)', () => {
  test('add → list → update → delete, de-duplicates same text+scope', async () => {
    const { s3 } = fakeS3();
    const h = await addHint(s3, 'b', 't1', 'app1', { text: '  點右下方的   SPIN  ', screen: '老虎機', source: 'operator', jobId: 'job-1', step: 3 });
    expect(h.text).toBe('點右下方的 SPIN');
    expect(h.id).toMatch(/^hint-[a-z0-9]+$/);
    expect(h.source).toBe('operator');
    const again = await addHint(s3, 'b', 't1', 'app1', { text: '點右下方的 SPIN', screen: '老虎機' });
    expect(again.id).toBe(h.id);
    expect(await listHints(s3, 'b', 't1', 'app1')).toHaveLength(1);

    const u = await updateHint(s3, 'b', 't1', 'app1', h.id, { enabled: false, text: '點右下角 SPIN', pageId: PAGE });
    expect(u).toMatchObject({ enabled: false, text: '點右下角 SPIN', pageId: PAGE });
    const cleared = await updateHint(s3, 'b', 't1', 'app1', h.id, { pageId: '' });
    expect(cleared.pageId).toBeUndefined();

    await deleteHint(s3, 'b', 't1', 'app1', h.id);
    expect(await listHints(s3, 'b', 't1', 'app1')).toEqual([]);
  });

  test('validation and not-found', async () => {
    const { s3 } = fakeS3();
    await expect(addHint(s3, 'b', 't1', 'app1', { text: '   ' })).rejects.toBeInstanceOf(HintValidationError);
    await expect(addHint(s3, 'b', 't1', 'app1', { text: 'x'.repeat(501) })).rejects.toBeInstanceOf(HintValidationError);
    await expect(addHint(s3, 'b', 't1', '../evil', { text: 'ok' })).rejects.toBeInstanceOf(HintValidationError);
    await expect(updateHint(s3, 'b', 't1', 'app1', 'hint-nothere1', { enabled: true })).rejects.toBeInstanceOf(HintNotFoundError);
    await expect(updateHint(s3, 'b', 't1', 'app1', 'bad id', { enabled: true })).rejects.toBeInstanceOf(HintValidationError);
    // pageId 格式不對就忽略(不當成綁定)
    const h = await addHint(s3, 'b', 't1', 'app1', { text: 'ok', pageId: 'nope' });
    expect(h.pageId).toBeUndefined();
  });

  test('retries on concurrent write conflict', async () => {
    const { s3 } = fakeS3({ conflictOnce: true });
    await addHint(s3, 'b', 't1', 'app1', { text: 'first' });
    expect((await listHints(s3, 'b', 't1', 'app1')).map((h) => h.text)).toEqual(['first']);
  });
});

test('isTransientScreenName: loading screens are not used as hint scope', () => {
  expect(isTransientScreenName('載入中')).toBe(true);
  expect(isTransientScreenName('Loading 33%')).toBe(true);
  expect(isTransientScreenName('老虎機主畫面')).toBe(false);
  expect(isTransientScreenName('畫面 87')).toBe(true);
  expect(isTransientScreenName('SELECT A GAME')).toBe(false);
});

describe('memory map edits (edits.json)', () => {
  test('parseEditOp validates', () => {
    expect(parseEditOp({ op: 'rename', pageId: PAGE, name: ' 老虎機 ' })).toEqual({ op: 'rename', pageId: PAGE, name: '老虎機' });
    expect(() => parseEditOp({ op: 'rename', pageId: PAGE })).toThrow(HintValidationError);
    expect(() => parseEditOp({ op: 'deletePage', pageId: 'x' })).toThrow(HintValidationError);
    expect(() => parseEditOp({ op: 'deleteEdge' })).toThrow(HintValidationError);
    expect(() => parseEditOp({ op: 'drop' })).toThrow(HintValidationError);
  });

  test('apply / undo ops', async () => {
    const { s3 } = fakeS3();
    await applyEdit(s3, 'b', 't1', 'app1', { op: 'rename', pageId: PAGE, name: '老虎機' });
    await applyEdit(s3, 'b', 't1', 'app1', { op: 'deletePage', pageId: 'page_ffffffff' });
    await applyEdit(s3, 'b', 't1', 'app1', { op: 'deleteEdge', edgeKey: 'a>b>tap>SPIN' });
    let e = await readEdits(s3, 'b', 't1', 'app1');
    expect(e).toMatchObject({ renames: { [PAGE]: '老虎機' }, deletedPages: ['page_ffffffff'], deletedEdges: ['a>b>tap>SPIN'] });
    await applyEdit(s3, 'b', 't1', 'app1', { op: 'clearRename', pageId: PAGE });
    await applyEdit(s3, 'b', 't1', 'app1', { op: 'restorePage', pageId: 'page_ffffffff' });
    await applyEdit(s3, 'b', 't1', 'app1', { op: 'restoreEdge', edgeKey: 'a>b>tap>SPIN' });
    e = await readEdits(s3, 'b', 't1', 'app1');
    expect(e).toMatchObject({ renames: {}, deletedPages: [], deletedEdges: [] });
  });

  test('parseEditOp: graph ops (move / addEdge / mergePage)', () => {
    const P2 = 'page_0123abce';
    expect(parseEditOp({ op: 'move', pageId: PAGE, x: 12.4, y: -3 })).toEqual({ op: 'move', pageId: PAGE, x: 12, y: -3 });
    expect(() => parseEditOp({ op: 'move', pageId: PAGE, x: 'a', y: 1 })).toThrow(HintValidationError);
    expect(parseEditOp({ op: 'moveMany', positions: { [PAGE]: { x: 1, y: 2 }, bad: { x: 1, y: 1 } } }))
      .toEqual({ op: 'moveMany', positions: { [PAGE]: { x: 1, y: 2 } } });
    expect(parseEditOp({ op: 'addEdge', fromPageId: PAGE, toPageId: P2, kind: 'tap', target: ' 開始  遊戲 ' })).toEqual({
      op: 'addEdge',
      edge: { fromPageId: PAGE, toPageId: P2, trigger: { kind: 'tap', label: 'tap 開始 遊戲', target: '開始 遊戲' } },
    });
    expect(parseEditOp({ op: 'addEdge', fromPageId: PAGE, toPageId: P2, kind: 'auto', target: 'x' })).toEqual({
      op: 'addEdge',
      edge: { fromPageId: PAGE, toPageId: P2, trigger: { kind: 'auto', label: 'auto' } },
    });
    expect(() => parseEditOp({ op: 'addEdge', fromPageId: PAGE, toPageId: PAGE, kind: 'tap' })).toThrow(HintValidationError);
    expect(() => parseEditOp({ op: 'addEdge', fromPageId: PAGE, toPageId: P2, kind: 'jump' })).toThrow(HintValidationError);
    expect(() => parseEditOp({ op: 'mergePage', pageId: PAGE, intoPageId: PAGE })).toThrow(HintValidationError);
  });

  test('apply graph ops: positions, addEdge ↔ deleteEdge, merge chain', async () => {
    const { s3 } = fakeS3();
    const A = 'page_aaaaaaaa', B = 'page_bbbbbbbb', C = 'page_cccccccc';
    const run = (body: Record<string, unknown>) => applyEdit(s3, 'b', 't1', 'app1', parseEditOp(body));
    await run({ op: 'move', pageId: A, x: 10, y: 20 });
    await run({ op: 'moveMany', positions: { [B]: { x: 1, y: 2 } } });
    await run({ op: 'deleteEdge', edgeKey: `${A}>${B}>tap>PLAY` });
    let e = await run({ op: 'addEdge', fromPageId: A, toPageId: B, kind: 'tap', target: 'PLAY' });
    expect(e.deletedEdges).toEqual([]); // 手動補回 = 取消刪除
    expect(e.addedEdges).toHaveLength(1);
    e = await run({ op: 'addEdge', fromPageId: A, toPageId: B, kind: 'tap', target: 'PLAY' });
    expect(e.addedEdges).toHaveLength(1); // 不重複
    e = await run({ op: 'deleteEdge', edgeKey: `${A}>${B}>tap>PLAY`, manualOnly: true });
    expect(e.addedEdges).toEqual([]);
    expect(e.deletedEdges).toEqual([]);
    await run({ op: 'addEdge', fromPageId: A, toPageId: C, kind: 'tap', target: 'GO' });
    await run({ op: 'mergePage', pageId: C, intoPageId: B });
    e = await run({ op: 'mergePage', pageId: B, intoPageId: A });
    expect(e.merges).toEqual({ [C]: A, [B]: A });
    expect(e.addedEdges).toEqual([]); // A→C 併成 A→A 自環 → 丟掉
    expect(e.positions).toEqual({ [A]: { x: 10, y: 20 } });
    await expect(run({ op: 'mergePage', pageId: A, intoPageId: C })).rejects.toThrow(HintValidationError);
    e = await run({ op: 'resetLayout' });
    expect(e.positions).toEqual({});
  });

  test('routes: validate, save (upsert), merge remaps pages, delete', async () => {
    const { s3 } = fakeS3();
    const A = 'page_aaaaaaaa', B = 'page_bbbbbbbb', C = 'page_cccccccc';
    const route = {
      id: 'route-abc123', name: ' 主線 ', enabled: true,
      steps: [{ id: 's-0001', pageId: A, action: ' 點  遊戲 ' }, { id: 's-0002', pageId: C, action: '通關' }],
      branches: [{ id: 'b-0001', fromStepId: 's-0002', pageId: B, action: '關彈窗' }],
    };
    const parsed = parseRoute(route);
    expect(parsed.name).toBe('主線');
    expect(parsed.steps[0]!.action).toBe('點 遊戲');
    expect(parsed.branches[0]!.returnStepId).toBe('s-0002'); // 預設回到同一步
    expect(() => parseRoute({ ...route, steps: [] })).toThrow(HintValidationError);
    expect(() => parseRoute({ ...route, id: 'x' })).toThrow(HintValidationError);
    expect(() => parseRoute({ ...route, steps: [route.steps[0], { ...route.steps[1], id: 's-0001' }] })).toThrow(HintValidationError);
    expect(() => parseRoute({ ...route, branches: [{ ...route.branches[0], fromStepId: 's-9999' }] })).toThrow(HintValidationError);

    const run = (body: Record<string, unknown>) => applyEdit(s3, 'b', 't1', 'app1', parseEditOp(body));
    let e = await run({ op: 'saveRoute', route });
    expect(e.routes).toHaveLength(1);
    e = await run({ op: 'saveRoute', route: { ...route, name: '主線 v2' } });
    expect(e.routes!.map((r) => r.name)).toEqual(['主線 v2']);
    e = await run({ op: 'mergePage', pageId: C, intoPageId: B });
    expect(e.routes![0]!.steps[1]!.pageId).toBe(B);
    e = await run({ op: 'deleteRoute', routeId: 'route-abc123' });
    expect(e.routes).toEqual([]);
  });
});

describe('operator commands', () => {
  test('validateCommandBody', () => {
    expect(validateCommandBody({ text: ' 點 SPIN ' })).toEqual({ text: '點 SPIN', remember: true });
    expect(validateCommandBody({ text: 'x', remember: false, screen: ' 大廳 ' })).toEqual({ text: 'x', remember: false, screen: '大廳' });
    expect(() => validateCommandBody({ text: '' })).toThrow(CommandValidationError);
    expect(() => validateCommandBody({})).toThrow(CommandValidationError);
    expect(() => validateCommandBody({ text: 'x'.repeat(501) })).toThrow(CommandValidationError);
  });

  test('validateCommandBody: screen point (with or without text)', () => {
    expect(validateCommandBody({ point: { x: 0.62, y: 0.88 } })).toEqual({ text: '點這個位置', remember: true, point: { x: 0.62, y: 0.88 }, pointOnly: true });
    expect(validateCommandBody({ text: '這是 SPIN', point: { x: 1, y: 0 } })).toMatchObject({ text: '這是 SPIN', point: { x: 1, y: 0 } });
    expect(validateCommandBody({ text: '這是 SPIN', point: { x: 1, y: 0 } }).pointOnly).toBeUndefined();
    expect(() => validateCommandBody({ point: { x: 1.2, y: 0.5 } })).toThrow(CommandValidationError);
    expect(() => validateCommandBody({ point: { x: 'a', y: 0.5 } })).toThrow(CommandValidationError);
  });

  test('operatorTurnNote: point commands carry position; tap-only points are not repeated as reminders', () => {
    const tapOnly = { id: 'cmd-1', text: '點這個位置', point: { x: 0.5, y: 0.9 } };
    const spin = { id: 'cmd-2', text: '這是 SPIN', point: { x: 0.85, y: 0.92 } };
    expect(operatorTurnNote([spin], [spin])).toContain('這是 SPIN(畫面位置約左起 85%、上起 92%)');
    const later = operatorTurnNote([], [tapOnly, spin]);
    expect(later).toContain('這是 SPIN');
    expect(later).not.toContain('點這個位置');
    expect(operatorTurnNote([], [tapOnly])).toBe('');
  });

  test('ids sort by time', () => {
    const a = newCommandId(1_000_000);
    const b = newCommandId(2_000_000);
    expect(a).toMatch(/^cmd-[a-z0-9]+$/);
    expect(a < b).toBe(true);
  });

  test('write → runner poll/ack → list shows ack', async () => {
    const { s3 } = fakeS3();
    const c1 = { id: newCommandId(1_000), text: '點右下方的 SPIN', createdAt: '2026-01-01T00:00:00Z', screen: '老虎機' };
    const c2 = { id: newCommandId(2_000), text: '關掉公告', createdAt: '2026-01-01T00:00:01Z' };
    await writeCommand(s3, 'b', 't1', 'job-1', c1);
    await expect(writeCommand(s3, 'b', 't1', 'job-1', c1)).rejects.toThrow(); // IfNoneMatch:不覆寫

    const ch = runnerMod.createOperatorChannel({
      s3,
      bucket: 'b',
      jobPrefix: 'tenants/t1/jobs/job-1',
      cmds: { ListObjectsV2Command, GetObjectCommand, PutObjectCommand },
    });
    const first = await ch.poll();
    expect(first.map((c: { text: string }) => c.text)).toEqual(['點右下方的 SPIN']);
    await ch.ack(first[0], { status: 'received', step: 4 });
    expect(await ch.poll()).toEqual([]); // 已讀過不重複

    await writeCommand(s3, 'b', 't1', 'job-1', c2);
    const second = await ch.poll();
    expect(second.map((c: { id: string }) => c.id)).toEqual([c2.id]);
    expect(ch.active).toHaveLength(2);
    await ch.ack(first[0], { status: 'applied', step: 4, reply: '依測試人員指令:點 SPIN', action: 'tap' });

    const list = await listCommands(s3, 'b', 't1', 'job-1');
    expect(list.map((c) => c.id)).toEqual([c1.id, c2.id]);
    expect(list[0]!.ack).toMatchObject({ status: 'applied', step: 4, action: 'tap' });
    expect(list[1]!.ack).toBeUndefined();
  });

  test('loadAppMemory reads enabled hints + edits', async () => {
    const { s3 } = fakeS3();
    const a = await addHint(s3, 'b', 't1', 'app1', { text: 'on' });
    const off = await addHint(s3, 'b', 't1', 'app1', { text: 'off' });
    await updateHint(s3, 'b', 't1', 'app1', off.id, { enabled: false });
    await applyEdit(s3, 'b', 't1', 'app1', { op: 'deletePage', pageId: PAGE });
    const mem = await runnerMod.loadAppMemory({ s3, bucket: 'b', memPrefix: 'tenants/t1/memory/app1', cmds: { GetObjectCommand } });
    expect(mem.hints.map((h) => h.id)).toEqual([a.id]);
    expect(mem.edits?.deletedPages).toEqual([PAGE]);
  });
});

describe('operatorMemory pure helpers', () => {
  const struct = () => ({
    rootPageId: 'p1',
    pages: {
      p1: { id: 'p1', name: '大廳' },
      p2: { id: 'p2', name: '老虎機' },
      p3: { id: 'p3', name: '商店' },
    } as Record<string, { id: string; name: string; renamed?: boolean; autoName?: string; transient?: boolean }>,
    edges: [
      { fromPageId: 'p1', toPageId: 'p2', trigger: { kind: 'tap', target: '老虎機' } },
      { fromPageId: 'p1', toPageId: 'p3', trigger: { kind: 'tap', target: '商店' } },
      { fromPageId: 'p2', toPageId: 'p1', trigger: { kind: 'back' } },
    ],
  });

  test('edgeKey', () => {
    expect(edgeKey({ fromPageId: 'a', toPageId: 'b', trigger: { kind: 'tap', target: ' SPIN ' } })).toBe('a>b>tap>SPIN');
    expect(edgeKey({ fromPageId: 'a', toPageId: 'b' })).toBe('a>b>>');
  });

  test('applyEdits: delete page cascades edges, delete edge, rename only when enabled', () => {
    const edits = { renames: { p2: 'SPIN 機台' }, deletedPages: ['p1'], deletedEdges: [] as string[] };
    const s = applyEdits(struct(), edits);
    expect(Object.keys(s.pages)).toEqual(['p2', 'p3']);
    expect(s.edges).toEqual([]);
    expect(s.rootPageId).toBe('p2');
    expect(s.pages['p2']).toMatchObject({ name: 'SPIN 機台', autoName: '老虎機', renamed: true });

    const r = applyEdits(struct(), { renames: { p2: 'x' }, deletedEdges: ['p1>p3>tap>商店'] }, { renames: false });
    expect(r.pages['p2']!.name).toBe('老虎機');
    expect(r.edges.map((e) => e.toPageId)).toEqual(['p2', 'p1']);
    expect(applyEdits(null, edits)).toBeNull();
  });

  test('applyEdits: merges combine pages and edges; addedEdges flagged manual', () => {
    const s0 = {
      rootPageId: 'p3',
      pages: {
        p1: { id: 'p1', name: '大廳', visitCount: 5, aliases: { 大廳: 5 }, pHashes: ['aa'], knownControlLabels: ['PLAY'] },
        p2: { id: 'p2', name: '老虎機', visitCount: 3, aliases: { 老虎機: 3 }, pHashes: ['bb'], knownControlLabels: ['SPIN'] },
        p3: { id: 'p3', name: '主頁', visitCount: 2, aliases: { 主頁: 2 }, pHashes: ['cc'], knownControlLabels: ['PLAY', 'SHOP'] },
      } as Record<string, Record<string, unknown>>,
      edges: [
        { fromPageId: 'p1', toPageId: 'p2', trigger: { kind: 'tap', target: 'PLAY' }, hitCount: 2, missCount: 0 },
        { fromPageId: 'p3', toPageId: 'p2', trigger: { kind: 'tap', target: 'PLAY' }, hitCount: 1, missCount: 1 },
        { fromPageId: 'p3', toPageId: 'p1', trigger: { kind: 'auto' }, hitCount: 1, missCount: 0 },
      ] as Array<Record<string, unknown> & { fromPageId: string; toPageId: string; trigger: { kind: string; target?: string } }>,
    };
    const s = applyEdits(structuredClone(s0), {
      merges: { p3: 'p1' },
      addedEdges: [
        { fromPageId: 'p2', toPageId: 'p1', trigger: { kind: 'back', label: 'back' } },
        { fromPageId: 'p1', toPageId: 'p2', trigger: { kind: 'tap', target: 'PLAY', label: 'tap PLAY' } },
        { fromPageId: 'p9', toPageId: 'p1', trigger: { kind: 'tap', label: 'tap' } }, // 不存在的畫面略過
      ],
    });
    expect(Object.keys(s.pages)).toEqual(['p1', 'p2']);
    expect(s.rootPageId).toBe('p1');
    expect(s.pages['p1']).toMatchObject({ visitCount: 7, aliases: { 大廳: 5, 主頁: 2 }, pHashes: ['aa', 'cc'], knownControlLabels: ['PLAY', 'SHOP'] });
    expect(s.edges).toEqual([
      { fromPageId: 'p1', toPageId: 'p2', trigger: { kind: 'tap', target: 'PLAY' }, hitCount: 3, missCount: 1, manual: true },
      { fromPageId: 'p2', toPageId: 'p1', trigger: { kind: 'back', label: 'back' }, hitCount: 0, missCount: 0, manual: true },
    ]);
    // runner 模式:不加人工路徑
    const r = applyEdits(structuredClone(s0), { addedEdges: [{ fromPageId: 'p2', toPageId: 'p1', trigger: { kind: 'back' } }] }, { addedEdges: false });
    expect(r.edges.some((e) => (e as { manual?: boolean }).manual)).toBe(false);
  });

  test('routesPromptSection / routeTurnNote: ordered steps + popup branch', () => {
    const routes = [
      {
        id: 'route-abcdef', name: '主線', enabled: true,
        steps: [
          { id: 's-0001', pageId: 'p1', action: '點選 xx 遊戲' },
          { id: 's-0002', pageId: 'p2', action: '開始除草殺敵直到通關' },
          { id: 's-0003', pageId: 'p3', action: '點下一關' },
        ],
        branches: [{ id: 'b-0001', fromStepId: 's-0002', pageId: 'p9', action: '關閉活動彈窗', returnStepId: 's-0002' }],
      },
      { id: 'route-off000', name: '停用', enabled: false, steps: [{ id: 's-0009', pageId: 'p1', action: 'x' }], branches: [] },
    ];
    const names: Record<string, string> = { p1: '大廳', p2: '第一關', p3: '結算', p9: '活動彈窗' };
    const nm = (id: string) => names[id] ?? '';
    const sys = routesPromptSection(routes, nm);
    expect(sys).toContain('路線「主線」');
    expect(sys).toContain('1. 在「大廳」:點選 xx 遊戲');
    expect(sys).toContain('支線(第 2 步時若出現「活動彈窗」):關閉活動彈窗 → 回到第 2 步');
    expect(sys).not.toContain('停用');
    expect(routesPromptSection([], nm)).toBe('');

    expect(routeTurnNote(routes, 'p2', nm)).toContain('第 2/3 步:開始除草殺敵直到通關;完成後前往第 3 步「結算」(點下一關)');
    expect(routeTurnNote(routes, 'p3', nm)).toContain('這是路線最後一步');
    expect(routeTurnNote(routes, 'p9', nm)).toContain('關閉活動彈窗,然後回到第 2 步「第一關」繼續');
    expect(routeTurnNote(routes, 'p7', nm)).toBe('');
    expect(routeTurnNote(routes, null, nm)).toBe('');
  });

  test('summarizeForAgent lists manual edges first (even 0 hits)', () => {
    const struct = {
      appName: 'a',
      rootPageId: 'p1',
      pages: {
        p1: { id: 'p1', name: '大廳', visitCount: 5, aliases: { 大廳: 5 }, pHash: '', knownControlLabels: [] },
        p2: { id: 'p2', name: '選關', visitCount: 3, aliases: { 選關: 3 }, pHash: 'ffffffffffffffff', knownControlLabels: [] },
      },
      edges: [{ fromPageId: 'p1', toPageId: 'p2', trigger: { kind: 'tap', target: '冒險' }, hitCount: 0, missCount: 2 }],
    };
    expect(summarizeForAgent(struct)).not.toContain('人工標註)');
    const s = applyEdits(structuredClone(struct), { addedEdges: [{ fromPageId: 'p1', toPageId: 'p2', trigger: { kind: 'tap', target: '冒險' } }] });
    const text = summarizeForAgent(s);
    expect(text).toContain('「大廳」 --tap 冒險--> 「選關」(人工標註)');
    expect(text).not.toContain('常失敗的操作');
  });

  test('sameScreen is lenient on punctuation/whitespace', () => {
    expect(sameScreen('老虎機 畫面', '「老虎機畫面」')).toBe(true);
    expect(sameScreen('老虎機', '老虎機主畫面')).toBe(true);
    expect(sameScreen('大廳', '商店')).toBe(false);
    expect(sameScreen('', '大廳')).toBe(false);
  });

  test('hintsPromptSection + screenHintsFor', () => {
    const hints = [
      { id: 'h1', text: '先關公告' },
      { id: 'h2', text: '點右下方 SPIN', screen: '老虎機' },
      { id: 'h3', text: '不要點商店', pageId: 'p1' },
      { id: 'h4', text: '停用的', enabled: false },
    ];
    const sec = hintsPromptSection(hints, (id) => (id === 'p1' ? '大廳' : id));
    expect(sec).toContain('- 先關公告');
    expect(sec).toContain('在「老虎機」畫面:點右下方 SPIN');
    expect(sec).toContain('在「大廳」畫面:不要點商店');
    expect(sec).not.toContain('停用的');
    expect(hintsPromptSection([])).toBe('');
    expect(hintsPromptSection(hints, undefined, 50).length).toBeLessThan(80);

    expect(screenHintsFor(hints, { screen: '老虎機主畫面' }).map((h) => h.id)).toEqual(['h2']);
    expect(screenHintsFor(hints, { pageId: 'p1' }).map((h) => h.id)).toEqual(['h3']);
    expect(screenHintsFor(hints, {})).toEqual([]);
  });

  test('operatorTurnNote: new command overrides conflicting older ones', () => {
    const c1 = { id: 'cmd-1', text: '點擊 step by step' };
    const c2 = { id: 'cmd-2', text: '改用 auto' };
    const c3 = { id: 'cmd-3', text: '改點 free spins' };
    expect(operatorTurnNote([], [])).toBe('');
    const note = operatorTurnNote([c3], [c1, c2, c3]);
    expect(note).toContain('最高優先');
    expect(note).toContain('「改點 free spins」');
    expect(note).toContain('取代');
    expect(note).toContain('較早的指令:「改用 auto」;「點擊 step by step」');
    // 沒有新指令時:由新到舊,明確標出最新那則
    const remind = operatorTurnNote([], [c1, c2, c3]);
    expect(remind).not.toContain('最高優先');
    expect(remind).toContain('最新「改點 free spins」');
    expect(remind).toContain('只照最新');
    // 延續中的指令物件不是同一個參考也要能辨識(以 id 比對)
    expect(operatorTurnNote([{ ...c3 }], [c1, c3])).toContain('較早的指令:「點擊 step by step」');
  });

  test('hints are ordered by time: prompt old→new, screen reminders newest first', () => {
    const hints = [
      { id: 'h2', text: '改選 FREE SPINS', screen: '選擇畫面', updatedAt: '2026-10-05T02:00:00Z' },
      { id: 'h1', text: '選 STEP BY STEP', screen: '選擇畫面', updatedAt: '2026-10-05T01:00:00Z' },
    ];
    const sec = hintsPromptSection(hints);
    expect(sec.indexOf('STEP BY STEP')).toBeLessThan(sec.indexOf('FREE SPINS'));
    expect(sec).toContain('只照最新那條');
    expect(screenHintsFor(hints, { screen: '選擇畫面' }).map((h) => h.id)).toEqual(['h2', 'h1']);
  });
});

describe('memoryGraph: loading screens are separate nodes', () => {
  // 1024-bit pHash(256 hex);兩張圖差很多 = 每個字元都不同。
  const hashA = 'a'.repeat(256);
  const hashB = '5'.repeat(256);
  const hashA2 = `${'a'.repeat(250)}${'b'.repeat(6)}`; // 與 A 幾乎相同(載入進度條在動)

  test('different loading screens stay apart; same one (visually) merges; names keep what is loading', () => {
    const s = emptyStructure('app');
    const lobby = upsertPage(s, { name: '大廳', pHash: '0'.repeat(256) }).pageId!;
    const ad = upsertPage(s, { name: 'Ocean King 2 廣告載入', pHash: hashA }).pageId!;
    const ad2 = upsertPage(s, { name: '載入中', pHash: hashA2 }).pageId!; // 泛稱,但畫面相同 → 同一個
    const mission = upsertPage(s, { name: "載入中(Newbie's Mission) LOADING 100% (3/3)", pHash: hashB }).pageId!;
    const generic = upsertPage(s, { name: '載入中', pHash: 'f'.repeat(256) }).pageId!; // 泛稱 + 畫面不同 → 不合併
    expect(ad2).toBe(ad);
    expect(new Set([ad, mission, generic]).size).toBe(3);
    expect(s.pages[ad]!).toMatchObject({ transient: true, name: 'Ocean King 2 廣告載入' });
    expect(s.pages[mission]!.name).toBe("載入中(Newbie's Mission)");
    expect(s.rootPageId).toBe(lobby);

    // 收斂(讀取時套用)不會再把它們併回一個「載入中」。
    recordTransition(s, lobby, ad, { action: 'tap', target: 'Ocean King 2' });
    recordTransition(s, ad, lobby, { action: 'wait' });
    const c = compactStructure(s);
    expect(Object.values(c.pages).filter((p) => p.transient)).toHaveLength(3);
    expect(c.edges).toHaveLength(2);
  });

  test('a loading screen never merges with a normal screen that looks the same', () => {
    const s = emptyStructure('app');
    const a = upsertPage(s, { name: '大廳', pHash: hashA }).pageId;
    const b = upsertPage(s, { name: '大廳載入中', pHash: hashA }).pageId;
    expect(a).not.toBe(b);
    expect(s.pages[b!]!.transient).toBe(true);
  });
});
