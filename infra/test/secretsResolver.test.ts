import { describe, it, expect } from 'vitest';
// 測 runner 端憑證解析的純函式(extractRefs)。resolveTaskSecrets 會 new SDK client,
// 屬整合層不在此單元測;此處聚焦「掃出哪些引用、租戶隔離」的核心邏輯。
// agent 是純 JS(無型別宣告);測試只用其純函式 extractRefs。
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
import { extractRefs } from '../../agent/secretsResolver.mjs';

const T = 'globex-us';
const PREFIX = `playagent/tenant/${T}/`;

describe('runner secretsResolver.extractRefs', () => {
  it('${NAME} 佔位 → 組成本租戶前綴的完整機密名', () => {
    const m = extractRefs('用帳號 ${TEST_USERNAME} 密碼 ${TEST_PASSWORD} 登入', T);
    expect(m.get('${TEST_USERNAME}')).toBe(`${PREFIX}TEST_USERNAME`);
    expect(m.get('${TEST_PASSWORD}')).toBe(`${PREFIX}TEST_PASSWORD`);
    expect(m.size).toBe(2);
  });

  it('secretRef:<本租戶全名> → 收;跨租戶前綴 → 不收', () => {
    const good = `secretRef:${PREFIX}pw`;
    const bad = 'secretRef:playagent/tenant/acme-tw/pw';
    const m = extractRefs(`${good} 與 ${bad}`, T);
    expect(m.get(good)).toBe(`${PREFIX}pw`);
    expect(m.has(bad)).toBe(false);
    expect(m.size).toBe(1);
  });

  it('同一佔位符重複只記一次(Map 去重)', () => {
    const m = extractRefs('${K} ... ${K} ... ${K}', T);
    expect(m.size).toBe(1);
    expect(m.get('${K}')).toBe(`${PREFIX}K`);
  });

  it('鍵名只允許英數與 _ . -(不合法字元不被當佔位)', () => {
    const m = extractRefs('${bad name} ${ok_key.v-1}', T);
    expect(m.has('${bad name}')).toBe(false);
    expect(m.get('${ok_key.v-1}')).toBe(`${PREFIX}ok_key.v-1`);
  });

  it('無引用 → 空 Map', () => {
    expect(extractRefs('開啟遊戲進入大廳', T).size).toBe(0);
  });
});
