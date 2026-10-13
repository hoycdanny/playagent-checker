import { describe, expect, test } from 'vitest';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { handleRequest, type ApiDeps } from '../lambda/api/core.js';
import { listHints } from '../lambda/api/memoryHints.js';
import {
  CommandValidationError,
  DRAG_ONLY_TEXT,
  newCommandId,
  POINT_ONLY_TEXT,
  validateCommandBody,
  writeCommand,
} from '../lambda/api/operatorCommands.js';
import {
  createOperatorChannel,
  DRAG_ONLY_TEXT as RUNNER_DRAG_ONLY_TEXT,
  DRAG_PRESS_MS,
  operatorGestureCmd,
  operatorTurnNote,
  POINT_ONLY_TEXT as RUNNER_POINT_ONLY_TEXT,
  validDragMs,
} from '../../agent/operatorMemory.mjs';
// @ts-expect-error imageTools.mjs has no type sidecar; only the pure arrow helper is used.
import { dragArrowDraws } from '../../agent/imageTools.mjs';

/** 最小 S3 假物件:Put(If-Match / If-None-Match + ETag)、Get、List。 */
function fakeS3() {
  const store = new Map<string, { body: string; etag: string }>();
  let n = 0;
  const send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const i = cmd.input;
    switch (cmd.constructor.name) {
      case 'PutObjectCommand': {
        const key = i['Key'] as string;
        const cur = store.get(key);
        const fail = () => { throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }); };
        if (i['IfNoneMatch'] === '*' && cur) fail();
        if (i['IfMatch'] !== undefined && (!cur || cur.etag !== i['IfMatch'])) fail();
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

describe('operator drag: API validation', () => {
  test('point + to → drag with clamped/default duration', () => {
    expect(validateCommandBody({ point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 }, dragMs: 850 })).toEqual({
      text: DRAG_ONLY_TEXT, remember: true, point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 }, dragMs: 850, pointOnly: true,
    });
    expect(validateCommandBody({ point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 } }).dragMs).toBe(600);
    expect(validateCommandBody({ point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 }, dragMs: 99_999 }).dragMs).toBe(5000);
    expect(validateCommandBody({ point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 }, dragMs: 1 }).dragMs).toBe(100);
    const described = validateCommandBody({ text: '把寶石拖到右邊', point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 } });
    expect(described.text).toBe('把寶石拖到右邊');
    expect(described.pointOnly).toBeUndefined();
  });

  test('a plain tap is unchanged (no to/dragMs)', () => {
    expect(validateCommandBody({ point: { x: 0.5, y: 0.5 }, dragMs: 900 })).toEqual({
      text: POINT_ONLY_TEXT, remember: true, point: { x: 0.5, y: 0.5 }, pointOnly: true,
    });
  });

  test('rejects malformed drags instead of silently tapping', () => {
    expect(() => validateCommandBody({ to: { x: 0.5, y: 0.5 } })).toThrow(CommandValidationError);
    expect(() => validateCommandBody({ point: { x: 0.5, y: 0.5 }, to: { x: 1.5, y: 0.5 } })).toThrow(/to 需為/);
    expect(() => validateCommandBody({ point: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 } })).toThrow(CommandValidationError);
    expect(() => validateCommandBody({ point: { x: 0.1, y: 0.5 }, to: { x: 0.5, y: 0.5 }, dragMs: 'slow' })).toThrow(CommandValidationError);
  });

  test('API and runner agree on the default texts', () => {
    expect(RUNNER_DRAG_ONLY_TEXT).toBe(DRAG_ONLY_TEXT);
    expect(RUNNER_POINT_ONLY_TEXT).toBe(POINT_ONLY_TEXT);
  });
});

describe('operator drag: POST /tasks/{id}/commands', () => {
  function deps() {
    const { s3, store } = fakeS3();
    return { store, s3, deps: { bucket: 'b', getTenantS3: async () => s3 } as unknown as ApiDeps };
  }
  const claims = { 'custom:tenantId': 't-001', sub: 'u-1', email: 'a@example.com' };
  async function seed(s3: S3Client, jobId: string) {
    await s3.send(new PutObjectCommand({ Bucket: 'b', Key: `tenants/t-001/jobs/${jobId}/status.json`, Body: JSON.stringify({ state: 'running', steps: 7 }) }));
    await s3.send(new PutObjectCommand({ Bucket: 'b', Key: `tenants/t-001/jobs/${jobId}/job.json`, Body: JSON.stringify({ appId: 'app-1' }) }));
  }

  test('stores to/dragMs on the command and remembers the drag path in words', async () => {
    const { s3, store, deps: d } = deps();
    await seed(s3, 'job-drag1');
    const res = await handleRequest({
      method: 'POST', path: '/tasks/job-drag1/commands', claims,
      body: { text: '把寶石拖到右邊格子', point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 }, dragMs: 900, screen: '背包' },
    }, d);
    expect(res.status).toBe(201);
    const cmd = res.body as Record<string, unknown>;
    expect(cmd).toMatchObject({ point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 }, dragMs: 900 });
    const saved = [...store.entries()].find(([k]) => k.includes('/commands/'))!;
    expect(JSON.parse(saved[1].body)).toMatchObject({ to: { x: 0.7, y: 0.3 }, dragMs: 900 });
    const hints = await listHints(s3, 'b', 't-001', 'app-1');
    expect(hints[0]!.text).toBe('把寶石拖到右邊格子(做法:從畫面左起 20%、上起 80% 按住,拖到左起 70%、上起 30% 放開)');
  });

  test('a drag without text is a one-off gesture: not remembered', async () => {
    const { s3, deps: d } = deps();
    await seed(s3, 'job-drag2');
    const res = await handleRequest({
      method: 'POST', path: '/tasks/job-drag2/commands', claims,
      body: { point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 } },
    }, d);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ text: DRAG_ONLY_TEXT, dragMs: 600 });
    expect(await listHints(s3, 'b', 't-001', 'app-1')).toEqual([]);
  });

  test('malformed drag → 400', async () => {
    const { s3, deps: d } = deps();
    await seed(s3, 'job-drag3');
    const res = await handleRequest({ method: 'POST', path: '/tasks/job-drag3/commands', claims, body: { to: { x: 0.7, y: 0.3 } } }, d);
    expect(res.status).toBe(400);
  });
});

describe('operator drag: runner side', () => {
  test('S3 channel carries to/dragMs; drops a degenerate or orphan "to"', async () => {
    const { s3 } = fakeS3();
    const base = { createdAt: '2026-01-01T00:00:00Z' };
    const drag = { ...base, id: newCommandId(1_000), text: DRAG_ONLY_TEXT, point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 }, dragMs: 900 };
    const same = { ...base, id: newCommandId(2_000), text: '點這個位置', point: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 } };
    const orphan = { ...base, id: newCommandId(3_000), text: '關掉公告', to: { x: 0.5, y: 0.5 } };
    for (const c of [drag, same, orphan]) await writeCommand(s3, 'b', 't1', 'job-1', c as never);
    const ch = createOperatorChannel({ s3, bucket: 'b', jobPrefix: 'tenants/t1/jobs/job-1', cmds: { ListObjectsV2Command, GetObjectCommand, PutObjectCommand } });
    const got = await ch.poll();
    expect(got[0]).toEqual({ id: drag.id, text: DRAG_ONLY_TEXT, point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 }, dragMs: 900 });
    expect(got[1]).toEqual({ id: same.id, text: '點這個位置', point: { x: 0.5, y: 0.5 } });
    expect(got[2]).toEqual({ id: orphan.id, text: '關掉公告' });
  });

  test('gesture → swipe in screenshot space (tap stays a tap)', () => {
    expect(operatorGestureCmd({ point: { x: 0.25, y: 0.5 } }, 1000, 2000)).toEqual({ action: 'tap', x: 250, y: 1000, operatorTap: true });
    expect(operatorGestureCmd({ point: { x: 0.25, y: 0.5 }, to: { x: 0.75, y: 0.1 }, dragMs: 800 }, 1000, 2000)).toEqual({
      action: 'swipe', x: 250, y: 1000, x2: 750, y2: 200, durationMs: 800,
      pressMs: DRAG_PRESS_MS, endHoldMs: DRAG_PRESS_MS, operatorTap: true, operatorDrag: true,
    });
    expect(operatorGestureCmd({ point: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, 10, 10)!).toMatchObject({ durationMs: 600 });
    expect(operatorGestureCmd({}, 10, 10)).toBeNull();
    expect(validDragMs('x')).toBe(600);
    expect(validDragMs(10_000)).toBe(5000);
  });

  test('prompt describes the drag path; gesture-only drags are not repeated later', () => {
    const dragOnly = { id: 'cmd-1', text: DRAG_ONLY_TEXT, point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 } };
    const gem = { id: 'cmd-2', text: '把寶石拖到右邊', point: { x: 0.2, y: 0.8 }, to: { x: 0.7, y: 0.3 } };
    expect(operatorTurnNote([gem], [gem])).toContain('把寶石拖到右邊(做法:從畫面左起 20%、上起 80% 按住,拖到左起 70%、上起 30% 放開)');
    expect(operatorTurnNote([dragOnly], [dragOnly])).toContain('「從畫面左起 20%、上起 80% 按住,拖到左起 70%、上起 30% 放開」');
    expect(operatorTurnNote([], [dragOnly])).toBe('');
    expect(operatorTurnNote([], [dragOnly, gem])).toContain('把寶石拖到右邊');
  });

  test('annotation arrow points at the drop location', () => {
    const [line, head, end] = dragArrowDraws(100, 500, 400, 500, 1000) as string[];
    expect(line).toBe('line 100,500 400,500');
    expect(end).toMatch(/^circle 400,500 /);
    // 往右拖:箭頭的兩翼在終點左側,上下對稱。
    const pts = head.replace('polygon ', '').split(' ').map((p) => p.split(',').map(Number));
    expect(pts[0]).toEqual([400, 500]);
    expect(pts[1]![0]).toBeLessThan(400);
    expect(pts[2]![0]).toBeLessThan(400);
    expect(pts[1]![1]! + pts[2]![1]!).toBe(1000);
  });
});
