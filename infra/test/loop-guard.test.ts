import { describe, expect, test } from 'vitest';
import { createLoopGuard } from '../../agent/loopGuard.mjs';

/**
 * 一步的觀測值。prevAction 由回放器自動從上一步補上,測試資料只寫畫面名/動作/有沒有變化。
 */
interface Step {
  screen: string;
  action: string;
  /** 上一步執行後畫面有沒有變;第 0 步沒有上一步,寫 undefined。 */
  changed?: boolean;
}

/** 把一串步驟餵進護欄,回傳「第幾步被判死」與每步的裁決。 */
function replay(steps: Step[], opts: { haveChangeSignal?: boolean; limit?: number } = {}) {
  const guard = createLoopGuard({ limit: opts.limit ?? 8 });
  const verdicts: Array<ReturnType<typeof guard.observe>> = [];
  let abortedAt: number | null = null;
  let prevAction: string | null = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const v = guard.observe({
      screen: s.screen,
      step: i,
      action: s.action,
      prevAction,
      // 第 0 步沒有可比對的前一張畫面,runner 會把 screenChanged 當 true。
      screenChanged: s.changed ?? true,
      haveChangeSignal: opts.haveChangeSignal ?? true,
    });
    verdicts.push(v);
    if (v.abort) {
      abortedAt = i;
      break;
    }
    prevAction = s.action;
  }
  return { guard, verdicts, abortedAt };
}

/**
 * job-mvg3h10o-df5maq 的真實 16 步(goodluck777.com 登入流程)。
 * 畫面名、動作、screenChanged 全部照 S3 上 steps/*.json 的實際值抄下來。
 * AI 當時正在一步一步填登入表單:帳號 → 密碼 → 驗證碼(2410,數字鍵盤逐位按)。
 */
const REAL_LOGIN_RUN: Step[] = [
  { screen: '年齡確認', action: 'tap' },                  // 0 關掉滿18歲彈窗
  { screen: '首頁', action: 'tap', changed: true },        // 1 點右上角登入
  { screen: '登入', action: 'tap', changed: true },        // 2 點帳號欄
  { screen: '登入', action: 'type', changed: true },       // 3 輸入帳號
  { screen: '登入', action: 'tap', changed: true },        // 4 點密碼欄
  { screen: '登入', action: 'tap', changed: false },       // 5 密碼欄沒聚焦,重點
  { screen: '登入', action: 'tap', changed: false },       // 6 還是沒反應,改按手機登入
  { screen: '手機登入', action: 'tap', changed: true },    // 7 不是帳密登入,返回
  { screen: '會員登入', action: 'tap', changed: true },    // 8 點帳號欄
  { screen: '會員登入', action: 'tap', changed: true },    // 9 重點帳號欄
  { screen: '會員登入', action: 'type', changed: true },   // 10 輸入帳號
  { screen: '會員登入', action: 'tap', changed: true },    // 11 點密碼欄
  { screen: '會員登入', action: 'type', changed: true },   // 12 輸入密碼
  { screen: '會員登入', action: 'tap', changed: true },    // 13 點驗證碼欄
  { screen: '會員登入', action: 'tap', changed: true },    // 14 按數字 2
  { screen: '會員登入', action: 'tap', changed: false },   // 15 按數字 4(這一步畫面沒變)
];

describe('createLoopGuard:登入表單不該被判死循環(job-mvg3h10o 迴歸)', () => {
  test('真實 16 步登入流程全程不中止', () => {
    const { abortedAt } = replay(REAL_LOGIN_RUN);
    expect(abortedAt).toBeNull();
  });

  test('「會員登入」連續 8 步,但只有 1 步畫面真的沒反應', () => {
    const { guard } = replay(REAL_LOGIN_RUN);
    const counts = guard.snapshot();
    // 舊判準在這裡會數到 8 而判死;新判準只認「做了動作卻沒反應」的那一步。
    expect(counts.get('會員登入')).toBe(1);
    // 第 5、6 步密碼欄真的點不動,這兩次是實質無效操作,應該被記下來。
    expect(counts.get('登入')).toBe(2);
    // 畫面每次都在變的,一次都不該計。
    expect(counts.get('首頁') ?? 0).toBe(0);
    expect(counts.get('手機登入') ?? 0).toBe(0);
  });

  test('畫面有變化的步驟一律不計入', () => {
    const { verdicts } = replay(REAL_LOGIN_RUN);
    const countedSteps = verdicts.flatMap((v, i) => (v.counted ? [i] : []));
    expect(countedSteps).toEqual([5, 6, 15]);
  });
});

describe('createLoopGuard:真的卡死還是要攔下來', () => {
  test('同一畫面連續 8 次操作都沒反應 → 中止', () => {
    const steps: Step[] = [
      { screen: '登入失敗', action: 'tap' },
      ...Array.from({ length: 8 }, () => ({ screen: '登入失敗', action: 'tap', changed: false })),
    ];
    const { abortedAt, verdicts } = replay(steps);
    // 第 0 步不計,之後 8 步各計一次,第 8 次(索引 8)達標中止。
    expect(abortedAt).toBe(8);
    expect(verdicts[8].seen).toBe(8);
    expect(verdicts[8].reason).toBe('no_response');
  });

  test('中途有反應會拉長但不歸零,仍然攔得住', () => {
    const steps: Step[] = [{ screen: 'X', action: 'tap' }];
    for (let n = 0; n < 8; n++) {
      steps.push({ screen: 'X', action: 'tap', changed: false });
      steps.push({ screen: 'X', action: 'tap', changed: true }); // 偶爾有反應
    }
    const { abortedAt } = replay(steps);
    expect(abortedAt).not.toBeNull();
  });

  test('中止訊息講的是「操作後沒有任何反應」,不是「畫面反覆出現」', () => {
    const guard = createLoopGuard({ limit: 8 });
    expect(guard.message('登入失敗', 8, 'no_response')).toContain('沒有任何反應');
    expect(guard.message('登入失敗', 8, 'repeat')).toContain('反覆出現');
  });
});

describe('createLoopGuard:不該計入的動作', () => {
  test('等待載入(wait)不算卡死,再多次也不中止', () => {
    const steps: Step[] = [
      { screen: '載入中', action: 'wait' },
      ...Array.from({ length: 30 }, () => ({ screen: '載入中', action: 'wait', changed: false })),
    ];
    const { abortedAt, guard } = replay(steps);
    expect(abortedAt).toBeNull();
    expect(guard.snapshot().get('載入中') ?? 0).toBe(0);
  });

  test('第 0 步沒有「上一步」,不計入', () => {
    const { verdicts } = replay([{ screen: 'A', action: 'tap', changed: false }]);
    expect(verdicts[0].counted).toBe(false);
  });

  test('上一步是 wait、這一步是 tap:不該被錯算成無效操作', () => {
    // 這是「拿這一步的動作去配上一步的結果」會踩到的 bug:
    // 畫面沒變是因為上一步只是在等載入,不是因為有人點了沒反應。
    const { verdicts } = replay([
      { screen: '載入中', action: 'wait' },
      { screen: '載入中', action: 'tap', changed: false },
    ]);
    expect(verdicts[1].counted).toBe(false);
  });

  test('reset() 之後次數歸零', () => {
    const guard = createLoopGuard({ limit: 8 });
    guard.observe({ screen: 'A', step: 1, action: 'tap', prevAction: 'tap', screenChanged: false });
    expect(guard.snapshot().get('A')).toBe(1);
    guard.reset();
    expect(guard.snapshot().get('A')).toBeUndefined();
  });
});

describe('createLoopGuard:拿不到變化訊號時的退路', () => {
  test('沒有 pHash 時退回「同畫面名計數」,成本護欄不消失', () => {
    const steps: Step[] = Array.from({ length: 10 }, () => ({ screen: '大廳', action: 'tap' }));
    const { abortedAt, verdicts } = replay(steps, { haveChangeSignal: false });
    expect(abortedAt).toBe(7); // 第 1 步就開始計,第 8 次(索引 7)達標
    expect(verdicts[7].reason).toBe('repeat');
  });

  test('退路也不把 wait / done 算進去', () => {
    const steps: Step[] = Array.from({ length: 20 }, (_, i) => ({
      screen: '載入中',
      action: i % 2 === 0 ? 'wait' : 'done',
    }));
    const { abortedAt } = replay(steps, { haveChangeSignal: false });
    expect(abortedAt).toBeNull();
  });
});
