import { afterEach, describe, expect, test } from 'vitest';
import { buildPageSignature } from '../../agent/pageSignature.mjs';

/**
 * buildPageSignature 是在瀏覽器頁面內執行的(Playwright evaluate 把原始碼送進頁面),
 * 本機沒有瀏覽器,所以用 stub 的 document / location 直接呼叫。
 * 這測的是指紋「對哪些變化敏感、對哪些刻意不敏感」,以及機密邊界。
 */

interface FakeField {
  tag: string;
  type?: string | null;
  value?: string;
}

/** 造一個最小 DOM:表單欄位 + 節點總數 + dialog 數 + 焦點。 */
function stubDom(o: {
  href?: string;
  fields?: FakeField[];
  nodeCount?: number;
  dialogs?: number;
  focusIndex?: number;
}) {
  const fields = (o.fields ?? []).map((f) => ({
    tagName: f.tag.toUpperCase(),
    value: f.value ?? '',
    getAttribute: (n: string) => (n === 'type' ? (f.type ?? null) : null),
  }));
  const active = o.focusIndex == null ? null : fields[o.focusIndex];
  const g = globalThis as unknown as Record<string, unknown>;
  g.location = { href: o.href ?? 'https://example.test/' };
  g.document = {
    activeElement: active,
    querySelectorAll: (sel: string) => (sel.includes('dialog') ? new Array(o.dialogs ?? 0).fill({}) : fields),
    getElementsByTagName: () => new Array(o.nodeCount ?? 100).fill({}),
  };
}

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.location;
  delete g.document;
});

describe('buildPageSignature:該抓到的變化', () => {
  test('輸入框多一個字 → 指紋改變(pHash 抓不到的就是這個)', () => {
    stubDom({ fields: [{ tag: 'input', type: 'text', value: '8' }] });
    const a = buildPageSignature();
    stubDom({ fields: [{ tag: 'input', type: 'text', value: '80' }] });
    expect(buildPageSignature()).not.toBe(a);
  });

  test('等長但換序(80 → 08)也抓得到', () => {
    stubDom({ fields: [{ tag: 'input', type: 'text', value: '80' }] });
    const a = buildPageSignature();
    stubDom({ fields: [{ tag: 'input', type: 'text', value: '08' }] });
    expect(buildPageSignature()).not.toBe(a);
  });

  test('焦點移動抓得到(點了欄位有沒有真的聚焦)', () => {
    const fields: FakeField[] = [
      { tag: 'input', type: 'text', value: 'a' },
      { tag: 'input', type: 'text', value: 'b' },
    ];
    stubDom({ fields, focusIndex: 0 });
    const a = buildPageSignature();
    stubDom({ fields, focusIndex: 1 });
    expect(buildPageSignature()).not.toBe(a);
  });

  test('網址改變抓得到', () => {
    stubDom({ href: 'https://example.test/a' });
    const a = buildPageSignature();
    stubDom({ href: 'https://example.test/b' });
    expect(buildPageSignature()).not.toBe(a);
  });

  test('插入節點(錯誤訊息/彈窗)抓得到', () => {
    stubDom({ nodeCount: 100 });
    const a = buildPageSignature();
    stubDom({ nodeCount: 103 });
    expect(buildPageSignature()).not.toBe(a);
  });

  test('對話框數量改變抓得到', () => {
    stubDom({ dialogs: 0 });
    const a = buildPageSignature();
    stubDom({ dialogs: 1 });
    expect(buildPageSignature()).not.toBe(a);
  });
});

describe('buildPageSignature:刻意不敏感的部分', () => {
  test('完全相同的狀態 → 指紋相同(才能當「沒反應」的依據)', () => {
    const shape = { fields: [{ tag: 'input', type: 'text', value: 'x' }], nodeCount: 50, dialogs: 1 };
    stubDom(shape);
    const a = buildPageSignature();
    stubDom(shape);
    expect(buildPageSignature()).toBe(a);
  });

  test('輪播只換既有節點的文字/圖片 → 指紋不變(否則護欄會永不觸發)', () => {
    // 輪播換圖不改表單狀態、不改節點總數,所以不該算成「頁面有反應」。
    stubDom({ fields: [{ tag: 'input', type: 'text', value: 'x' }], nodeCount: 420 });
    const a = buildPageSignature();
    stubDom({ fields: [{ tag: 'input', type: 'text', value: 'x' }], nodeCount: 420 });
    expect(buildPageSignature()).toBe(a);
  });
});

describe('buildPageSignature:機密邊界', () => {
  test('密碼欄只記長度,指紋裡不含密碼值也不含其雜湊', () => {
    stubDom({ fields: [{ tag: 'input', type: 'password', value: 'sup3rs3cret' }] });
    const sig = buildPageSignature();
    expect(sig).toContain(':pw:11');
    expect(sig).not.toContain('sup3rs3cret');
    // 同長度的不同密碼必須產生相同指紋 —— 證明值完全沒進去。
    stubDom({ fields: [{ tag: 'input', type: 'password', value: 'aaaaaaaaaaa' }] });
    expect(buildPageSignature()).toBe(sig);
  });

  test('非密碼欄不存明文,只存長度與雜湊', () => {
    stubDom({ fields: [{ tag: 'input', type: 'text', value: 'hoyc.danny@example.test' }] });
    const sig = buildPageSignature();
    expect(sig).not.toContain('hoyc.danny@example.test');
    expect(sig).not.toContain('@example.test');
  });
});

describe('buildPageSignature:不會炸掉', () => {
  test('沒有任何表單欄位也回得出指紋', () => {
    stubDom({ fields: [] });
    expect(typeof buildPageSignature()).toBe('string');
  });

  test('textarea / select 沒有 type 屬性時改用標籤名', () => {
    stubDom({ fields: [{ tag: 'textarea', type: null, value: 'hi' }, { tag: 'select', type: null, value: 'tw' }] });
    const sig = buildPageSignature();
    expect(sig).toContain('0:textarea:2');
    expect(sig).toContain('1:select:2');
  });
});
