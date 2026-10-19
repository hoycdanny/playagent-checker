import { describe, expect, test } from 'vitest';
import { builtinKbDescription, genreFromBuiltinKbId } from './builtinKbText.ts';
import { GENRES } from '../GenreIcon.tsx';

const LOCALES = ['zh-Hant', 'en', 'zh-Hans', 'ja', 'ko'] as const;

describe('builtinKbDescription', () => {
  // 這是這個表存在的理由:後端只給一個繁中字串,所以日文 / 英文介面原本整頁都是中文。
  test('每個語系都給該語系的字,不會漏回繁中', () => {
    const got = LOCALES.map((l) => builtinKbDescription('slot', l));
    expect(got[0]).toContain('轉軸');
    expect(got[1]).toContain('Reels');
    expect(got[2]).toContain('转轴');
    expect(got[3]).toContain('リール');
    expect(got[4]).toContain('릴');
    // 五個語系互不相同(抓「複製貼上忘了改」)
    expect(new Set(got).size).toBe(5);
  });

  test('每一個已知 genre 都有五語系的說明,而且都不是空的', () => {
    for (const g of GENRES) {
      for (const l of LOCALES) {
        const s = builtinKbDescription(g, l);
        expect(s, `${g} / ${l}`).toBeTruthy();
        expect(String(s).trim(), `${g} / ${l}`).not.toBe('');
      }
    }
  });

  test('非中文語系的說明不該夾帶中日韓漢字以外的中文殘留', () => {
    // 英文說明若還留著中文,就是漏翻。只檢查英文(日韓本來就有漢字)。
    for (const g of GENRES) {
      const en = String(builtinKbDescription(g, 'en'));
      expect(en, g).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  test('認不出的 genre 回 undefined(呼叫端退回後端給的字,不會變空白)', () => {
    expect(builtinKbDescription('not-a-genre', 'ja')).toBeUndefined();
    expect(builtinKbDescription(undefined, 'ja')).toBeUndefined();
  });

  test('未知語系退回英文', () => {
    expect(builtinKbDescription('slot', 'de')).toBe(builtinKbDescription('slot', 'en'));
  });
});

describe('genreFromBuiltinKbId', () => {
  test('從內建 id 取出 genre;其他 id 回 undefined', () => {
    expect(genreFromBuiltinKbId('kb-builtin-slot')).toBe('slot');
    expect(genreFromBuiltinKbId('kb-builtin-tower_defense')).toBe('tower_defense');
    expect(genreFromBuiltinKbId('kb-abc123')).toBeUndefined();
    expect(genreFromBuiltinKbId(undefined)).toBeUndefined();
  });
});
