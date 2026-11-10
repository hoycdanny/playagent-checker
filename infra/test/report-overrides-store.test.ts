import { describe, expect, test } from 'vitest';
import {
  MAX_REASON,
  OverrideValidationError,
  appendOverride,
  clearOverrides,
  composeHintText,
  parseRememberContext,
  readOverrides,
  validateOverrideInput,
} from '../lambda/api/reportOverrides.js';

/**
 * 覆寫的儲存層。
 *
 * 守兩件事:
 *   1. **伺服器填覆核者與時間** —— 前端自報等於讓任何人冒名覆寫。
 *   2. **只追加,不修改既有紀錄** —— 撤回是再追加一筆改回去,原本那筆仍在。
 *      允許就地修改或刪除單筆,覆寫就從「可追溯的另一種主張」退化成
 *      「可以悄悄改掉的數字」。
 */

/** 極簡的記憶體 S3:只實作這支模組用到的兩個指令。 */
function fakeS3() {
  const store = new Map<string, string>();
  const client = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      const key = String(cmd.input['Key']);
      if (name === 'PutObjectCommand') {
        store.set(key, String(cmd.input['Body']));
        return {};
      }
      if (name === 'GetObjectCommand') {
        if (!store.has(key)) throw new Error('NoSuchKey');
        const body = store.get(key)!;
        return { Body: { transformToString: async () => body } };
      }
      throw new Error('unexpected command ' + name);
    },
  };
  return { client: client as never, store };
}

const B = 'bucket';
const T = 'tenant-1';
const J = 'job-1';
const KEY = `tenants/${T}/jobs/${J}/overrides.json`;

describe('validateOverrideInput', () => {
  test('標為誤判的最小合法輸入', () => {
    expect(validateOverrideInput({ findingId: 'F-07', dismissed: true, reason: '載入中' }))
      .toEqual({ findingId: 'F-07', dismissed: true, reason: '載入中' });
  });

  test('理由是必填,空白也不算', () => {
    for (const reason of [undefined, '', '   ']) {
      expect(() => validateOverrideInput({ findingId: 'F-07', dismissed: true, reason }))
        .toThrow(OverrideValidationError);
    }
  });

  test('findingId 是必填', () => {
    expect(() => validateOverrideInput({ dismissed: true, reason: 'x' })).toThrow(OverrideValidationError);
  });

  test('什麼都沒改要擋下來', () => {
    expect(() => validateOverrideInput({ findingId: 'F-07', reason: '只是想留個註解' }))
      .toThrow(OverrideValidationError);
  });

  test('不認識的分類或嚴重性要擋下來', () => {
    expect(() => validateOverrideInput({ findingId: 'F-07', reason: 'x', classification: 'NOPE' }))
      .toThrow(OverrideValidationError);
    expect(() => validateOverrideInput({ findingId: 'F-07', reason: 'x', severity: 'apocalyptic' }))
      .toThrow(OverrideValidationError);
  });

  test('理由過長要擋下來', () => {
    expect(() => validateOverrideInput({ findingId: 'F-07', dismissed: true, reason: 'x'.repeat(MAX_REASON + 1) }))
      .toThrow(OverrideValidationError);
  });

  test('前端自報的覆核者與時間一律忽略', () => {
    const out = validateOverrideInput({
      findingId: 'F-07', dismissed: true, reason: 'x',
      by: 'admin@example.test', at: '1999-01-01T00:00:00.000Z',
    }) as Record<string, unknown>;
    // 讓前端自報覆核者等於讓任何人冒名覆寫
    expect(out['by']).toBeUndefined();
    expect(out['at']).toBeUndefined();
  });

  test('標為誤判時忽略同時送來的分類與嚴重性(以誤判為準)', () => {
    const out = validateOverrideInput({
      findingId: 'F-07', dismissed: true, reason: 'x', classification: 'ENVIRONMENT', severity: 'low',
    }) as Record<string, unknown>;
    expect(out['classification']).toBeUndefined();
    expect(out['severity']).toBeUndefined();
  });

  test('理由前後空白會去掉', () => {
    expect(validateOverrideInput({ findingId: ' F-07 ', dismissed: true, reason: '  載入中  ' }))
      .toEqual({ findingId: 'F-07', dismissed: true, reason: '載入中' });
  });
});

describe('readOverrides', () => {
  test('沒有檔案時回空陣列,不丟錯', async () => {
    const { client } = fakeS3();
    expect(await readOverrides(client, B, T, J)).toEqual([]);
  });

  test('內容不是陣列時回空陣列', async () => {
    const { client, store } = fakeS3();
    store.set(KEY, '{"nope":1}');
    expect(await readOverrides(client, B, T, J)).toEqual([]);
  });

  test('壞掉的 JSON 回空陣列,不讓報告失敗', async () => {
    const { client, store } = fakeS3();
    store.set(KEY, '{{{');
    expect(await readOverrides(client, B, T, J)).toEqual([]);
  });

  test('一筆壞掉不會讓整份覆寫消失', async () => {
    const { client, store } = fakeS3();
    store.set(KEY, JSON.stringify([
      { findingId: 'F-01', dismissed: true, reason: 'ok', by: 'a@x.test', at: '2026-11-09T10:00:00.000Z' },
      { findingId: 'F-02', dismissed: true, reason: '', by: 'a@x.test', at: '2026-11-09T10:00:00.000Z' },
    ]));
    const out = await readOverrides(client, B, T, J);
    expect(out).toHaveLength(1);
    expect(out[0]!.findingId).toBe('F-01');
  });
});

describe('appendOverride:只追加', () => {
  test('伺服器填入覆核者與時間', async () => {
    const { client } = fakeS3();
    const out = await appendOverride(
      client, B, T, J,
      validateOverrideInput({ findingId: 'F-07', dismissed: true, reason: '載入中' }),
      'tester@example.test',
      () => '2026-11-09T10:00:00.000Z',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.by).toBe('tester@example.test');
    expect(out[0]!.at).toBe('2026-11-09T10:00:00.000Z');
  });

  test('第二筆是追加,不是取代 —— 稽核軌跡要完整', async () => {
    const { client } = fakeS3();
    await appendOverride(client, B, T, J,
      validateOverrideInput({ findingId: 'F-07', dismissed: true, reason: '以為是載入中' }),
      'a@example.test', () => '2026-11-09T10:00:00.000Z');
    const out = await appendOverride(client, B, T, J,
      validateOverrideInput({ findingId: 'F-07', classification: 'GAME_FAILURE', reason: '重現過了,是真的缺陷' }),
      'b@example.test', () => '2026-11-09T12:00:00.000Z');

    // 兩筆都留著:誰在什麼時候改成什麼、後來被誰改回來,整串看得到
    expect(out).toHaveLength(2);
    expect(out[0]!.by).toBe('a@example.test');
    expect(out[1]!.by).toBe('b@example.test');
    expect(out[0]!.dismissed).toBe(true);
    expect(out[1]!.classification).toBe('GAME_FAILURE');
  });

  test('寫入後讀回來一致', async () => {
    const { client } = fakeS3();
    await appendOverride(client, B, T, J,
      validateOverrideInput({ findingId: 'F-07', severity: 'low', reason: '影響有限' }),
      'a@example.test', () => '2026-11-09T10:00:00.000Z');
    const back = await readOverrides(client, B, T, J);
    expect(back).toHaveLength(1);
    expect(back[0]!.severity).toBe('low');
  });
});

describe('clearOverrides', () => {
  test('清空後讀回空陣列', async () => {
    const { client } = fakeS3();
    await appendOverride(client, B, T, J,
      validateOverrideInput({ findingId: 'F-07', dismissed: true, reason: 'x' }),
      'a@example.test', () => '2026-11-09T10:00:00.000Z');
    await clearOverrides(client, B, T, J);
    expect(await readOverrides(client, B, T, J)).toEqual([]);
  });
});

// ───────────────────── 回寫應用記憶 ─────────────────────

/**
 * 覆核理由回寫記憶。
 *
 * 這是**跨任務**的副作用:一筆理由會影響這個 App 之後所有測試。所以守兩件事:
 *   1. 預設不回寫 —— 跨任務的影響必須是明確選的,不能靠預設值悄悄發生。
 *   2. 記憶文字要有指向 —— 單獨一句理由對 AI 沒用,它不知道在說哪個畫面的哪個現象。
 */
describe('parseRememberContext', () => {
  test('沒有指定就是不回寫', () => {
    expect(parseRememberContext({}).remember).toBe(false);
    expect(parseRememberContext({ remember: false }).remember).toBe(false);
    // 字串 'true' 不算 —— 只接受布林,避免前端送錯型別就悄悄開啟
    expect(parseRememberContext({ remember: 'true' }).remember).toBe(false);
  });

  test('明確勾選才回寫', () => {
    expect(parseRememberContext({ remember: true }).remember).toBe(true);
  });

  test('標題與畫面名會去空白並截斷', () => {
    const out = parseRememberContext({
      remember: true, findingTitle: '  大廳列表空白  ', screen: 'x'.repeat(300),
    });
    expect(out.findingTitle).toBe('大廳列表空白');
    expect(out.screen!.length).toBeLessThanOrEqual(120);
  });

  test('空白的標題與畫面名視為沒有', () => {
    const out = parseRememberContext({ remember: true, findingTitle: '   ', screen: '' });
    expect(out.findingTitle).toBeUndefined();
    expect(out.screen).toBeUndefined();
  });
});

describe('composeHintText', () => {
  test('標為誤判:帶出畫面、現象與原文理由', () => {
    const t = composeHintText({
      dismissed: true, reason: '載入中的正常狀態', findingTitle: '大廳列表空白', screen: '大廳',
    });
    expect(t).toContain('大廳畫面');
    expect(t).toContain('「大廳列表空白」');
    expect(t).toContain('判定不是缺陷');
    // 理由必須原文保留 —— 改寫就不再是他說的話
    expect(t).toContain('載入中的正常狀態');
  });

  test('確認為缺陷:結論相反,其餘一致', () => {
    const t = composeHintText({ dismissed: false, reason: '重現過三次', findingTitle: '餘額沒更新' });
    expect(t).toContain('確認為缺陷');
    expect(t).toContain('重現過三次');
    expect(t).not.toContain('不是缺陷');
  });

  test('沒有標題時仍是一句可讀的話,不留空洞', () => {
    const t = composeHintText({ dismissed: true, reason: '環境問題' });
    expect(t).toContain('先前回報的現象');
    expect(t).toContain('環境問題');
    expect(t).not.toContain('「」');
  });

  test('過長的標題與畫面名會被截短,不把整段描述灌進記憶', () => {
    const t = composeHintText({
      dismissed: true, reason: 'x', findingTitle: 'a'.repeat(300), screen: 'b'.repeat(300),
    });
    expect(t.length).toBeLessThan(300);
  });
});
