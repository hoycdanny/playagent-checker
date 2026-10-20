import { describe, expect, test } from 'vitest';
import {
  takeoverScriptToYaml,
  TakeoverValidationError,
  validateTakeoverAction,
} from '../lambda/api/takeover.js';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入(runner 模組)
const { normalizeAction, createTakeover } = await import('../../agent/takeover.mjs');

/**
 * 接管模式。兩端各有一道把關:API 擋不合法的輸入,runner 再 normalize 一次
 * (S3 上的檔案可能被別的途徑寫入)。兩邊都要擋,不能只靠其中一邊。
 */

describe('validateTakeoverAction(API 端把關)', () => {
  test('tap 需要座標', () => {
    expect(validateTakeoverAction({ kind: 'tap', point: { x: 0.5, y: 0.25 } }))
      .toEqual({ kind: 'tap', point: { x: 0.5, y: 0.25 } });
    expect(() => validateTakeoverAction({ kind: 'tap' })).toThrow(TakeoverValidationError);
  });

  test('座標超出 0~1 直接拒絕,不夾值(夾了會點到別的地方)', () => {
    expect(() => validateTakeoverAction({ kind: 'tap', point: { x: 1.5, y: 0.5 } })).toThrow(TakeoverValidationError);
    expect(() => validateTakeoverAction({ kind: 'tap', point: { x: -0.1, y: 0.5 } })).toThrow(TakeoverValidationError);
    expect(() => validateTakeoverAction({ kind: 'tap', point: { x: 'a', y: 0.5 } })).toThrow(TakeoverValidationError);
  });

  test('drag 需要起點與終點,且不能相同', () => {
    const r = validateTakeoverAction({ kind: 'drag', point: { x: 0.1, y: 0.1 }, to: { x: 0.9, y: 0.9 }, dragMs: 800 });
    expect(r).toMatchObject({ kind: 'drag', dragMs: 800 });
    expect(() => validateTakeoverAction({ kind: 'drag', point: { x: 0.1, y: 0.1 } })).toThrow(TakeoverValidationError);
    expect(() => validateTakeoverAction({ kind: 'drag', point: { x: 0.1, y: 0.1 }, to: { x: 0.1, y: 0.1 } }))
      .toThrow(TakeoverValidationError);
  });

  test('dragMs 超出範圍夾住(時間長短不影響落點,夾了是安全的)', () => {
    expect(validateTakeoverAction({ kind: 'drag', point: { x: 0, y: 0 }, to: { x: 1, y: 1 }, dragMs: 99999 }))
      .toMatchObject({ dragMs: 5000 });
    expect(validateTakeoverAction({ kind: 'drag', point: { x: 0, y: 0 }, to: { x: 1, y: 1 } }))
      .toMatchObject({ dragMs: 600 });
  });

  test('key / type / back', () => {
    expect(validateTakeoverAction({ kind: 'key', key: 'enter', repeat: 3 })).toMatchObject({ kind: 'key', key: 'enter', repeat: 3 });
    expect(() => validateTakeoverAction({ kind: 'key', key: '  ' })).toThrow(TakeoverValidationError);
    expect(validateTakeoverAction({ kind: 'type', text: 'hello' })).toEqual({ kind: 'type', text: 'hello' });
    expect(() => validateTakeoverAction({ kind: 'type', text: '' })).toThrow(TakeoverValidationError);
    expect(validateTakeoverAction({ kind: 'back' })).toEqual({ kind: 'back' });
  });

  test('沒見過的 kind 拒絕(不要把不認識的動作送到裝置)', () => {
    expect(() => validateTakeoverAction({ kind: 'explode' })).toThrow(TakeoverValidationError);
    expect(() => validateTakeoverAction({})).toThrow(TakeoverValidationError);
  });
});

describe('normalizeAction(runner 端把關)', () => {
  test('合法的照收', () => {
    expect(normalizeAction({ kind: 'tap', point: { x: 0.5, y: 0.5 } }, 'cmd-abc123'))
      .toEqual({ id: 'cmd-abc123', kind: 'tap', point: { x: 0.5, y: 0.5 } });
  });

  test('壞資料回 null 而不是亂猜(寧可丟掉一次點擊)', () => {
    expect(normalizeAction({ kind: 'tap' }, 'cmd-abc123')).toBeNull();
    expect(normalizeAction({ kind: 'tap', point: { x: 2, y: 0 } }, 'cmd-abc123')).toBeNull();
    expect(normalizeAction({ kind: 'nope' }, 'cmd-abc123')).toBeNull();
    expect(normalizeAction(null, 'cmd-abc123')).toBeNull();
  });

  test('drag 缺終點就不執行(只有起點等於不知道要拖去哪)', () => {
    expect(normalizeAction({ kind: 'drag', point: { x: 0.1, y: 0.1 } }, 'cmd-abc123')).toBeNull();
  });
});

/** 造一個假的 S3:只實作 takeover 用到的三個 command。 */
function fakeS3(objects: Record<string, string>) {
  const sent: string[] = [];
  return {
    sent,
    objects,
    async send(cmd: { __kind: string; input: Record<string, string> }) {
      if (cmd.__kind === 'get') {
        const body = objects[cmd.input['Key']!];
        if (body === undefined) throw new Error('NoSuchKey');
        return { Body: { transformToString: async () => body } };
      }
      if (cmd.__kind === 'list') {
        const prefix = cmd.input['Prefix']!;
        const after = cmd.input['StartAfter'];
        const keys = Object.keys(objects).filter((k) => k.startsWith(prefix) && (!after || k > after)).sort();
        return { Contents: keys.map((Key) => ({ Key })) };
      }
      sent.push(cmd.input['Key']!);
      objects[cmd.input['Key']!] = cmd.input['Body']!;
      return {};
    },
  };
}
const cmds = {
  GetObjectCommand: class { __kind = 'get'; constructor(public input: unknown) {} },
  ListObjectsV2Command: class { __kind = 'list'; constructor(public input: unknown) {} },
  PutObjectCommand: class { __kind = 'put'; constructor(public input: unknown) {} },
};

function makeTakeover(objects: Record<string, string>, now = () => 1_000_000) {
  const s3 = fakeS3(objects);
  const t = createTakeover({ s3, bucket: 'b', jobPrefix: 'p/jobs/job-1', cmds, now });
  return { t, s3 };
}

describe('createTakeover:開關', () => {
  test('沒有檔案 = 沒開(預設 AI 照跑,不會因為讀不到就停下來)', async () => {
    const { t } = makeTakeover({});
    expect(await t.enabled(0)).toBe(false);
  });

  test('enabled=true 才算開', async () => {
    const { t } = makeTakeover({ 'p/jobs/job-1/takeover.json': JSON.stringify({ enabled: true }) });
    expect(await t.enabled(0)).toBe(true);
  });

  test('壞掉的 JSON 當成沒開(不要因為一個壞檔就卡住任務)', async () => {
    const { t } = makeTakeover({ 'p/jobs/job-1/takeover.json': '{{{' });
    expect(await t.enabled(0)).toBe(false);
  });

  test('有快取:maxAgeMs 內不重讀', async () => {
    const objects = { 'p/jobs/job-1/takeover.json': JSON.stringify({ enabled: true }) };
    let clock = 1_000_000;
    const { t } = makeTakeover(objects, () => clock);
    expect(await t.enabled(0)).toBe(true);
    objects['p/jobs/job-1/takeover.json'] = JSON.stringify({ enabled: false });
    clock += 500;
    expect(await t.enabled(1000)).toBe(true);  // 還在快取內
    clock += 600;
    expect(await t.enabled(1000)).toBe(false); // 過期後讀到新值
  });
});

describe('createTakeover:輸入(游標式讀取)', () => {
  const act = (kind: string, extra: Record<string, unknown> = {}) => JSON.stringify({ kind, ...extra });

  test('依時間序讀出,且不重複讀(游標)', async () => {
    const { t } = makeTakeover({
      'p/jobs/job-1/takeover/cmd-aaa111.json': act('tap', { point: { x: 0.1, y: 0.1 } }),
      'p/jobs/job-1/takeover/cmd-bbb222.json': act('tap', { point: { x: 0.2, y: 0.2 } }),
    });
    const first = await t.poll();
    expect(first.map((a: { point: { x: number } }) => a.point.x)).toEqual([0.1, 0.2]);
    expect(await t.poll()).toEqual([]); // 第二次沒有新的
  });

  test('新進來的才讀,舊的不再讀一次', async () => {
    const objects: Record<string, string> = {
      'p/jobs/job-1/takeover/cmd-aaa111.json': act('tap', { point: { x: 0.1, y: 0.1 } }),
    };
    const { t } = makeTakeover(objects);
    expect((await t.poll()).length).toBe(1);
    objects['p/jobs/job-1/takeover/cmd-ccc333.json'] = act('back');
    const next = await t.poll();
    expect(next.map((a: { kind: string }) => a.kind)).toEqual(['back']);
  });

  test('垃圾檔名與壞內容會被跳過,不影響其他筆', async () => {
    const { t } = makeTakeover({
      'p/jobs/job-1/takeover/notanid.json': act('tap', { point: { x: 0.1, y: 0.1 } }),
      'p/jobs/job-1/takeover/cmd-bbb222.json': '{{{',
      'p/jobs/job-1/takeover/cmd-ccc333.json': act('tap', { point: { x: 0.3, y: 0.3 } }),
    });
    const got = await t.poll();
    expect(got.map((a: { point: { x: number } }) => a.point.x)).toEqual([0.3]);
  });

  test('ack 寫回執', async () => {
    const { t, s3 } = makeTakeover({});
    await t.ack({ id: 'cmd-aaa111' }, { status: 'applied', step: 4 });
    expect(s3.sent).toEqual(['p/jobs/job-1/takeover-ack/cmd-aaa111.json']);
  });

  test('統計會累計操作筆數', async () => {
    const { t } = makeTakeover({
      'p/jobs/job-1/takeover/cmd-aaa111.json': act('tap', { point: { x: 0.1, y: 0.1 } }),
      'p/jobs/job-1/takeover/cmd-bbb222.json': act('back'),
    });
    await t.poll();
    expect(t.stats.actions).toBe(2);
  });
});

describe('takeoverScriptToYaml(【AI 學習 B】錄製 → 可重跑的腳本)', () => {
  const script = {
    jobId: 'job-1',
    startUrl: 'https://example.test/',
    platform: 'web',
    actions: [
      { seq: 0, kind: 'tap', screen: '會員登入', point: { x: 0.5, y: 0.6 } },
      { seq: 1, kind: 'type', screen: '會員登入', text: '${帳號}' },
      { seq: 2, kind: 'drag', screen: '大廳', point: { x: 0.1, y: 0.5 }, to: { x: 0.9, y: 0.5 }, dragMs: 500 },
      { seq: 3, kind: 'key', screen: '大廳', key: 'enter', repeat: 2 },
      { seq: 4, kind: 'back', screen: '大廳' },
    ],
  };

  test('帶上名稱與起始網址', () => {
    const y = takeoverScriptToYaml(script, '登入流程');
    expect(y).toContain('name: "登入流程"');
    expect(y).toContain('url: "https://example.test/"');
  });

  test('每個操作一個編號步驟,並寫出所在畫面', () => {
    const y = takeoverScriptToYaml(script, 'x');
    expect(y).toContain('1. 在「會員登入」點擊畫面位置 (50%, 60%)');
    expect(y).toContain('2. 在「會員登入」輸入「${帳號}」');
    expect(y).toContain('3. 在「大廳」從 (10%, 50%) 拖曳到 (90%, 50%)');
    expect(y).toContain('4. 在「大廳」按下按鍵 enter 2 次');
    expect(y).toContain('5. 在「大廳」返回上一頁');
  });

  test('憑證佔位符原樣保留,絕不寫入真值', () => {
    const y = takeoverScriptToYaml(script, 'x');
    expect(y).toContain('${帳號}');
  });

  test('座標用百分比,並提醒改寫成元件描述(版面改動會失效)', () => {
    const y = takeoverScriptToYaml(script, 'x');
    expect(y).toContain('%');
    expect(y).toContain('元件描述');
  });

  test('沒錄到操作時明講,而不是產生一個空腳本', () => {
    const y = takeoverScriptToYaml({ jobId: 'j', actions: [] }, 'x');
    expect(y).toContain('沒有錄到任何操作');
  });
});
