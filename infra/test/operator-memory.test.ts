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
  sameScreen,
  screenHintsFor,
} from '../../agent/operatorMemory.mjs';
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
