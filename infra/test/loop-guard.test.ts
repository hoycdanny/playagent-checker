import { describe, expect, test } from 'vitest';
import { createLoopGuard } from '../../agent/loopGuard.mjs';

/**
 * 一步的觀測值。prevAction 由回放器自動從上一步補上。
 * changed:上一步執行後「狀態有沒有變」;null = 拿不到任何訊號。
 */
interface Step {
  screen: string;
  action: string;
  changed?: boolean | null;
}

/** 把一串步驟餵進護欄,回傳「第幾步被判死」與每步的裁決。 */
function replay(steps: Step[], opts: { limit?: number } = {}) {
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
      changed: s.changed === undefined ? true : s.changed,
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

const countedSteps = (verdicts: Array<{ counted: boolean }>) =>
  verdicts.flatMap((v, i) => (v.counted ? [i] : []));

/**
 * ───────────────────────────────────────────────────────────────────────
 * 實測 1:job-mvg3h10o-df5maq(goodluck777.com 登入,16 步)
 * 畫面名、動作、screenChanged 全部照 S3 上 steps/*.json 的實際值。
 * 這筆是「照畫面名計數」(v1)的受害者:AI 一步步填登入表單,全程停在「會員登入」。
 * ───────────────────────────────────────────────────────────────────────
 */
const RUN_MVG3H10O: Step[] = [
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
  { screen: '會員登入', action: 'tap', changed: false },   // 15 按數字 4
];

describe('v1 迴歸:登入表單停在同一個畫面名,不該被判死(job-mvg3h10o)', () => {
  test('真實 16 步全程不中止', () => {
    expect(replay(RUN_MVG3H10O).abortedAt).toBeNull();
  });

  test('「會員登入」連續 8 步,但只有 1 步真的沒反應', () => {
    const counts = replay(RUN_MVG3H10O).guard.snapshot();
    expect(counts.get('會員登入')).toBe(1); // v1 在這裡會數到 8 而判死
    expect(counts.get('登入')).toBe(2);      // 第 5、6 步密碼欄真的點不動,該算
    expect(counts.get('首頁') ?? 0).toBe(0);
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────
 * 實測 2:job-mvgdtt5i-16zx11(同一個網站,17 步)
 *
 * 這筆是「只看截圖 pHash」(v2)的受害者。驗證碼是 8009,數字鍵盤會把數字插在游標位置,
 * 於是欄位變成 8 → 80 → 080,AI 接著想清空重填。每一步其實都有效,但 pHash 是 32x32
 * 灰階感知雜湊、門檻 40/1024,驗證碼欄只佔約 8 格 —— 改一個數字翻不到門檻。
 *
 * phash 欄:S3 上 steps/*.json 記的真實 screenChanged 值。
 * dom  欄:依 AI 每步回報的欄位內容推出來的「DOM 指紋會不會變」—— 欄位值有變(8→80、
 *          08→0)就是 true;AI 明確說「未作用/未反應」且 prevResult=fail 的就是 false。
 *          這一欄不是量到的,是推的;測的是護欄在兩個訊號下的組合邏輯。
 * ───────────────────────────────────────────────────────────────────────
 */
const RUN_MVGDTT5I: Array<{ screen: string; action: string; phash?: boolean; dom?: boolean }> = [
  { screen: '年齡確認', action: 'tap' },                                  // 0
  { screen: '首頁', action: 'tap', phash: true, dom: true },               // 1 點登入
  { screen: '會員登入', action: 'tap', phash: true, dom: true },           // 2 點帳號欄
  { screen: '會員登入', action: 'type', phash: true, dom: true },          // 3 輸入帳號
  { screen: '會員登入', action: 'tap', phash: true, dom: true },           // 4 點密碼欄
  { screen: '會員登入', action: 'type', phash: true, dom: true },          // 5 輸入密碼
  { screen: '會員登入', action: 'tap', phash: false, dom: true },          // 6 密碼已填入(DOM 變了)
  { screen: '會員登入', action: 'tap', phash: true, dom: true },           // 7 驗證碼鍵盤開啟
  { screen: '會員登入', action: 'tap', phash: false, dom: true },          // 8 欄位出現 8
  { screen: '會員登入', action: 'tap', phash: false, dom: true },          // 9 欄位變 80
  { screen: '會員登入', action: 'tap', phash: true, dom: true },           // 10 欄位變 080
  { screen: '會員登入', action: 'key', phash: true, dom: true },           // 11 想用鍵盤退格
  { screen: '會員登入', action: 'tap', phash: false, dom: false },         // 12 鍵盤退格未作用
  { screen: '會員登入', action: 'tap', phash: false, dom: true },          // 13 退格成功,剩 08
  { screen: '會員登入', action: 'tap', phash: false, dom: true },          // 14 剩 0
  { screen: '會員登入', action: 'tap', phash: false, dom: false },         // 15 退格鍵沒反應
  { screen: '會員登入', action: 'tap', phash: false, dom: false },         // 16 改按刷新驗證碼
];

const asPhashOnly = (): Step[] =>
  RUN_MVGDTT5I.map((s, i) => ({ screen: s.screen, action: s.action, changed: i === 0 ? true : s.phash }));

const asUnion = (): Step[] =>
  RUN_MVGDTT5I.map((s, i) => ({
    screen: s.screen,
    action: s.action,
    // runner 餵的就是這個聯集:任一訊號看到反應就算有反應。
    changed: i === 0 ? true : s.dom === true || s.phash === true,
  }));

describe('v2 不夠用的證據:只看 pHash 會把填表單判成卡死(job-mvgdtt5i)', () => {
  test('只餵 pHash → 第 16 步被判死(重現線上那次失敗)', () => {
    const { abortedAt, verdicts } = replay(asPhashOnly());
    expect(abortedAt).toBe(16);
    expect(verdicts[16].seen).toBe(8);
    expect(verdicts[16].reason).toBe('no_response');
  });

  test('只餵 pHash → 連「欄位剛多一個數字」都被算成無效操作', () => {
    const { verdicts } = replay(asPhashOnly());
    // 第 8、9 步分別讓欄位出現 8、變成 80,是真實進展,卻被計入。
    expect(verdicts[8].counted).toBe(true);
    expect(verdicts[9].counted).toBe(true);
  });
});

describe('v3:DOM ∪ pHash 的聯集訊號(job-mvgdtt5i)', () => {
  test('餵聯集 → 全程不中止', () => {
    expect(replay(asUnion()).abortedAt).toBeNull();
  });

  test('只算 AI 自己都說沒反應的那 3 步', () => {
    const { guard, verdicts } = replay(asUnion());
    expect(countedSteps(verdicts)).toEqual([12, 15, 16]);
    expect(guard.snapshot().get('會員登入')).toBe(3);
  });

  test('DOM 說有變就不計,即使 pHash 說沒變', () => {
    const { verdicts } = replay(asUnion());
    for (const i of [6, 8, 9, 13, 14]) expect(verdicts[i].counted).toBe(false);
  });
});

describe('createLoopGuard:真的卡死還是要攔下來', () => {
  test('同一畫面連續 8 次操作、兩個訊號都沒反應 → 中止', () => {
    const steps: Step[] = [
      { screen: '登入失敗', action: 'tap' },
      ...Array.from({ length: 8 }, () => ({ screen: '登入失敗', action: 'tap', changed: false })),
    ];
    const { abortedAt, verdicts } = replay(steps);
    expect(abortedAt).toBe(8); // 第 0 步不計,之後 8 步各計一次
    expect(verdicts[8].seen).toBe(8);
  });

  test('偶爾有反應會拉長但次數不歸零,仍然攔得住', () => {
    const steps: Step[] = [{ screen: 'X', action: 'tap' }];
    for (let n = 0; n < 8; n++) {
      steps.push({ screen: 'X', action: 'tap', changed: false });
      steps.push({ screen: 'X', action: 'tap', changed: true });
    }
    expect(replay(steps).abortedAt).not.toBeNull();
  });

  test('中止訊息要講清楚是「狀態與畫面都沒變化」,不是「畫面反覆出現」', () => {
    const guard = createLoopGuard();
    expect(guard.message('登入失敗', 8, 'no_response')).toContain('都沒有任何變化');
    expect(guard.message('登入失敗', 8, 'repeat')).toContain('反覆出現');
  });
});

describe('createLoopGuard:不該計入的情形', () => {
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
    expect(replay([{ screen: 'A', action: 'tap', changed: false }]).verdicts[0].counted).toBe(false);
  });

  test('上一步是 wait、這一步是 tap:不該被錯算成無效操作', () => {
    // 畫面沒變是因為上一步只是在等載入,不是因為有人點了沒反應。
    const { verdicts } = replay([
      { screen: '載入中', action: 'wait' },
      { screen: '載入中', action: 'tap', changed: false },
    ]);
    expect(verdicts[1].counted).toBe(false);
  });

  test('reset() 之後次數歸零', () => {
    const guard = createLoopGuard();
    guard.observe({ screen: 'A', step: 1, action: 'tap', prevAction: 'tap', changed: false });
    expect(guard.snapshot().get('A')).toBe(1);
    guard.reset();
    expect(guard.snapshot().get('A')).toBeUndefined();
  });
});

describe('createLoopGuard:完全拿不到變化訊號時的退路', () => {
  test('changed = null → 退回「同畫面名計數」,成本護欄不消失', () => {
    const steps: Step[] = Array.from({ length: 10 }, () => ({ screen: '大廳', action: 'tap', changed: null }));
    const { abortedAt, verdicts } = replay(steps);
    expect(abortedAt).toBe(7); // 退路從第 0 步就計,第 8 次(索引 7)達標
    expect(verdicts[7].reason).toBe('repeat');
  });

  test('退路也不把 wait / done 算進去', () => {
    const steps: Step[] = Array.from({ length: 20 }, (_, i) => ({
      screen: '載入中',
      action: i % 2 === 0 ? 'wait' : 'done',
      changed: null,
    }));
    expect(replay(steps).abortedAt).toBeNull();
  });
});
