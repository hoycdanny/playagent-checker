import { describe, expect, test } from 'vitest';
import { judgeTypedText } from '../../agent/inputCheck.mjs';

/**
 * 「剛才那段字有沒有進到欄位裡」的三態判斷(agent/inputCheck.mjs)。
 *
 * 為什麼要有這組測試:真機上 `mobile: type` 遇到遊戲自繪的輸入框會「不丟錯也沒輸入」,
 * runner 只看到「type 成功」—— 客戶回報的「測試憑證預設值只能在模擬器上用,
 * 切到真機就無法輸入」就是這個形狀。這個判斷一旦把「無法確認」當成「成功」,問題就回來了。
 */

describe('judgeTypedText', () => {
  test('欄位內容含有送進去的字 → 成功', () => {
    expect(judgeTypedText('tester01', 'tester01')).toBe(true);
    expect(judgeTypedText('tester01', '帳號:tester01')).toBe(true);
  });

  test('欄位讀回來明確沒有這段字 → 確定失敗(呼叫端換下一個輸入管道)', () => {
    expect(judgeTypedText('tester01', '請輸入帳號')).toBe(false);
    expect(judgeTypedText('tester01', 'test')).toBe(false);
  });

  test('密碼遮罩:長度相符 → 無法確認;長度不符 → 確定失敗', () => {
    expect(judgeTypedText('pass1234', '••••••••')).toBeNull();
    expect(judgeTypedText('pass1234', '********')).toBeNull();
    expect(judgeTypedText('abcd', '●●●●')).toBeNull();
    expect(judgeTypedText('abcd', '  ••••  ')).toBeNull();
    expect(judgeTypedText('pass1234', '••')).toBe(false);
  });

  test('讀不到內容(Unity canvas / 沒有可讀元件)→ 無法確認', () => {
    expect(judgeTypedText('tester01', '')).toBeNull();
    expect(judgeTypedText('tester01', null)).toBeNull();
    expect(judgeTypedText('tester01', undefined)).toBeNull();
  });

  test('沒有送任何字 → 沒什麼要驗', () => {
    expect(judgeTypedText('', 'whatever')).toBeNull();
  });

  test('遮罩永遠不會回 true —— 「不知道」不可以變成「以為輸入成功」', () => {
    expect(judgeTypedText('pass1234', '••••••••')).not.toBe(true);
  });
});
