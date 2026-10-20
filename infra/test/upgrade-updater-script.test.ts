import { describe, expect, test } from 'vitest';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入(安裝/升級腳本)
const s = await import('../../scripts/upgrade-updater.mjs');

/**
 * scripts/upgrade-updater.mjs 的純邏輯。
 *
 * 這個腳本是給「已安裝的環境」手動跑一次用的,跑錯會改到別的環境,
 * 所以偵測與把關的邏輯要測:寧可要求使用者指定,也不要猜。
 */

describe('findUpdaterStacks:從 stack 名稱認出環境', () => {
  test('認出 <前綴>-Updater 並取出前綴', () => {
    expect(s.findUpdaterStacks(['PlayAgentDev-Foundation', 'PlayAgentDev-Updater'])).toEqual([
      { stackName: 'PlayAgentDev-Updater', prefix: 'PlayAgentDev' },
    ]);
  });

  test('非 dev stage 的前綴也認得', () => {
    expect(s.findUpdaterStacks(['PlayAgent-prod-Updater'])).toEqual([
      { stackName: 'PlayAgent-prod-Updater', prefix: 'PlayAgent-prod' },
    ]);
  });

  test('同一區域有多個環境時全部回傳(呼叫端會要求指定,不自己猜)', () => {
    const r = s.findUpdaterStacks(['PlayAgentDev-Updater', 'PlayAgent-prod-Updater', 'Other-Stack']);
    expect(r.map((x: { prefix: string }) => x.prefix)).toEqual(['PlayAgentDev', 'PlayAgent-prod']);
  });

  test('名稱只是「包含」Updater 不算(避免誤認別人的 stack)', () => {
    expect(s.findUpdaterStacks(['UpdaterThing', 'My-Updater-Old', 'x'])).toEqual([]);
  });

  test('空輸入不炸', () => {
    expect(s.findUpdaterStacks([])).toEqual([]);
    expect(s.findUpdaterStacks(undefined)).toEqual([]);
  });
});

describe('classifyStackStatus:什麼狀態可以更新', () => {
  test('完成狀態可以更新', () => {
    for (const st of ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE']) {
      expect(s.classifyStackStatus(st).ok).toBe(true);
    }
  });

  test('變更中 → 不可更新,並說要等', () => {
    const r = s.classifyStackStatus('UPDATE_IN_PROGRESS');
    expect(r.ok).toBe(false);
    expect(r.why).toContain('等它結束');
  });

  test('ROLLBACK_COMPLETE → 要先刪掉重建(CloudFormation 不允許更新)', () => {
    const r = s.classifyStackStatus('ROLLBACK_COMPLETE');
    expect(r.ok).toBe(false);
    expect(r.why).toContain('刪除');
  });

  test('UPDATE_ROLLBACK_FAILED → 要先 Continue rollback', () => {
    expect(s.classifyStackStatus('UPDATE_ROLLBACK_FAILED').why).toContain('Continue rollback');
  });

  test('找不到 stack → 指向完整安裝,而不是叫人重跑這個腳本', () => {
    const r = s.classifyStackStatus('MISSING');
    expect(r.ok).toBe(false);
    expect(r.why).toContain('deploy-latest.mjs');
  });

  test('沒見過的狀態一律不放行', () => {
    expect(s.classifyStackStatus('DELETE_FAILED').ok).toBe(false);
    expect(s.classifyStackStatus('').ok).toBe(false);
    expect(s.classifyStackStatus(undefined).ok).toBe(false);
  });
});

describe('verifyProject:確認升級真的生效(看結果,不看有沒有跑過部署)', () => {
  const good = {
    concurrentBuildLimit: 1,
    source: { buildspec: '... 部署前檢查通過 ... PA_UPDATER_STACK ...' },
  };

  test('都就位 → 沒有問題', () => {
    expect(s.verifyProject(good)).toEqual([]);
  });

  test('並行上限沒設 → 指出兩個更新會互撞', () => {
    const p = s.verifyProject({ ...good, concurrentBuildLimit: undefined });
    expect(p.join()).toContain('互撞');
  });

  test('並行上限被設成別的值也要抓出來', () => {
    expect(s.verifyProject({ ...good, concurrentBuildLimit: 5 }).length).toBe(1);
  });

  test('buildspec 缺部署前檢查 → 指出卡住的 stack 不會被擋下', () => {
    const p = s.verifyProject({ concurrentBuildLimit: 1, source: { buildspec: 'PA_UPDATER_STACK' } });
    expect(p.join()).toContain('部署前檢查');
  });

  test('buildspec 缺自我更新 → 指出之後還要手動跑', () => {
    const p = s.verifyProject({ concurrentBuildLimit: 1, source: { buildspec: '部署前檢查' } });
    expect(p.join()).toContain('自我更新');
  });

  test('整個專案讀不到時列出所有問題,而不是當成通過', () => {
    expect(s.verifyProject(undefined).length).toBe(3);
  });
});

describe('parseArgs', () => {
  test('預設值', () => {
    expect(s.parseArgs([])).toMatchObject({ region: '', stage: '', planOnly: false, yes: false });
  });

  test('認得各選項', () => {
    expect(s.parseArgs(['--region', 'us-west-2', '--stage', 'dev', '--plan-only', '-y']))
      .toMatchObject({ region: 'us-west-2', stage: 'dev', planOnly: true, yes: true });
  });

  test('--help 不執行其他動作', () => {
    expect(s.parseArgs(['--help']).help).toBe(true);
  });

  test('不支援的參數要報錯,不要靜默忽略(打錯字會以為設定生效了)', () => {
    expect(() => s.parseArgs(['--regionn', 'us-west-2'])).toThrow();
  });

  test('選項缺值要報錯', () => {
    expect(() => s.parseArgs(['--region'])).toThrow();
  });
});

describe('CANDIDATE_REGIONS', () => {
  test('包含預設部署區域,且第一個就是它(大多數環境一次就命中)', () => {
    expect(s.CANDIDATE_REGIONS[0]).toBe('us-west-2');
  });
});
