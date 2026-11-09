import { describe, expect, test } from 'vitest';
import { sanitizeNetworkSpec } from '../lambda/engine/webRunner.js';

/**
 * 案例 YAML 的 network: 是租戶自己寫的內容,而它會變成 runner 容器的環境變數。
 *
 * 這組測試守兩件事:
 *   1. 合法的條件要原樣通過 —— engine 不做語意解析,解析只有 runner 一處,
 *      兩邊各自實作遲早會分歧,而分歧的後果是報告主張一個沒施加的條件。
 *   2. 不合形狀的值要回 null 而不是截斷後放行 —— 半個條件比沒有條件更危險。
 */
describe('sanitizeNetworkSpec:形狀把關,不做語意解析', () => {
  test('常見的條件寫法原樣通過', () => {
    expect(sanitizeNetworkSpec('latency=1000')).toBe('latency=1000');
    expect(sanitizeNetworkSpec('latency=1000,down=400,up=200')).toBe('latency=1000,down=400,up=200');
    expect(sanitizeNetworkSpec('offline')).toBe('offline');
    expect(sanitizeNetworkSpec('loss=10')).toBe('loss=10');
  });

  test('帶單位與小數的值也通過(單位由 runner 處理)', () => {
    expect(sanitizeNetworkSpec('latency=1000ms,loss=2.5%')).toBe('latency=1000ms,loss=2.5%');
  });

  test('引號與前後空白會被剝掉', () => {
    expect(sanitizeNetworkSpec('  "latency=300"  ')).toBe('latency=300');
    expect(sanitizeNetworkSpec("'offline'")).toBe('offline');
  });

  test('engine 不替 runner 判斷哪一項做不到:丟包照樣放行', () => {
    // 丟包在瀏覽器後端做不到,但那要由 runner 寫進 unsupported 才會出現在報告裡。
    // engine 在這裡擋掉的話,報告就不知道案例曾經要求過丟包。
    expect(sanitizeNetworkSpec('loss=50')).toBe('loss=50');
  });

  test('空值與非字串一律視為沒宣告', () => {
    expect(sanitizeNetworkSpec('')).toBeNull();
    expect(sanitizeNetworkSpec('   ')).toBeNull();
    expect(sanitizeNetworkSpec(undefined)).toBeNull();
    expect(sanitizeNetworkSpec(null)).toBeNull();
    expect(sanitizeNetworkSpec(1000)).toBeNull();
    expect(sanitizeNetworkSpec({ latencyMs: 1000 })).toBeNull();
  });

  test('含空白或控制字元的值不放行(不截斷、不拼回去)', () => {
    expect(sanitizeNetworkSpec('latency=1000 && rm -rf /')).toBeNull();
    expect(sanitizeNetworkSpec('latency=1000\nup=1')).toBeNull();
    expect(sanitizeNetworkSpec('latency=1000; echo hi')).toBeNull();
    expect(sanitizeNetworkSpec('$(whoami)')).toBeNull();
    expect(sanitizeNetworkSpec('latency=1000`id`')).toBeNull();
  });

  test('超長的值整個拒收,不截斷', () => {
    const long = 'latency=1000,' + 'down=400,'.repeat(50);
    expect(long.length).toBeGreaterThan(120);
    // 截斷會產生一個語法仍然合法、但條件與案例所寫不同的字串 ——
    // 那正是「報告主張了沒施加的條件」的來源,所以寧可整個不放行。
    expect(sanitizeNetworkSpec(long)).toBeNull();
  });
});
